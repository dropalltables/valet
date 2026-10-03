import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import {
  buildNotification,
  buildPushPayload,
  buildWebhookRequest,
  notificationEvent,
  signPayload,
  testNotification,
} from '../src/notifications/payload.js'
import { assertPostableUrl, pushSubscriptionSchema } from '../src/notifications/service.js'
import { assertPublicAddress, pinnedLookup } from '../src/notifications/network.js'

const base = 'https://valet.example.com'

const finished = buildNotification({
  event: 'finished',
  threadId: 'abc123',
  title: 'Fix login bug',
  error: null,
  baseUrl: base,
  at: '2026-09-07T12:00:00.000Z',
})

test('status transitions that raise a notification', () => {
  assert.equal(notificationEvent('running', 'waiting'), 'waiting')
  assert.equal(notificationEvent('idle', 'waiting'), 'waiting')
  assert.equal(notificationEvent('running', 'idle'), 'finished')
  assert.equal(notificationEvent('waiting', 'idle'), 'finished')
  assert.equal(notificationEvent('provisioning', 'error'), 'error')
  assert.equal(notificationEvent('running', 'error'), 'error')
  // A wake, a pause, and provisioning are not turns ending.
  assert.equal(notificationEvent('paused', 'idle'), null)
  assert.equal(notificationEvent('provisioning', 'idle'), null)
  assert.equal(notificationEvent('idle', 'paused'), null)
  assert.equal(notificationEvent('idle', 'running'), null)
  assert.equal(notificationEvent('idle', 'archived'), null)
  assert.equal(notificationEvent('waiting', 'waiting'), null)
})

test('notification text and link', () => {
  assert.equal(finished.body, 'Finished')
  assert.equal(finished.url, 'https://valet.example.com/threads/abc123')
  const waiting = buildNotification({ event: 'waiting', threadId: 'a', title: 'T', error: null, baseUrl: base })
  assert.equal(waiting.body, 'Needs your input')
  const failed = buildNotification({ event: 'error', threadId: 'a', title: 'T', error: 'setup exited 1', baseUrl: base })
  assert.equal(failed.body, 'Error: setup exited 1')
  const bare = buildNotification({ event: 'error', threadId: 'a', title: 'T', error: null, baseUrl: base })
  assert.equal(bare.body, 'Error')
  // A base URL with a path prefix still yields an absolute thread link.
  const local = buildNotification({ event: 'finished', threadId: 'z9', title: 'T', error: null, baseUrl: 'http://localhost:3000' })
  assert.equal(local.url, 'http://localhost:3000/threads/z9')
})

test('push payload carries only what the service worker reads', () => {
  assert.deepEqual(JSON.parse(buildPushPayload(finished)), {
    title: 'Fix login bug',
    body: 'Finished',
    url: 'https://valet.example.com/threads/abc123',
    threadId: 'abc123',
  })
  assert.ok(Buffer.byteLength(buildPushPayload(finished)) < 4096)
})

test('slack payload escapes mrkdwn', () => {
  const n = buildNotification({ event: 'error', threadId: 'a', title: 'Fix <b> & </b>', error: 'x', baseUrl: base })
  const req = buildWebhookRequest('slack', null, n)
  assert.equal(req.headers['content-type'], 'application/json')
  const body = JSON.parse(req.body) as { text: string; blocks: Array<{ text: { text: string } }> }
  assert.equal(body.text, 'Fix <b> & </b> — Error: x')
  assert.equal(body.blocks[0]?.text.text, '*Fix &lt;b&gt; &amp; &lt;/b&gt;*\nError: x\n<https://valet.example.com/threads/a>')
})

test('discord payload uses an embed so titles need no escaping', () => {
  const req = buildWebhookRequest('discord', null, finished)
  assert.deepEqual(JSON.parse(req.body), {
    embeds: [{ title: 'Fix login bug', description: 'Finished', url: 'https://valet.example.com/threads/abc123' }],
  })
})

test('ntfy puts metadata in headers and encodes non-ascii titles', () => {
  const req = buildWebhookRequest('ntfy', null, finished)
  assert.equal(req.body, 'Finished')
  assert.equal(req.headers.Title, 'Fix login bug')
  assert.equal(req.headers.Priority, 'default')
  assert.equal(req.headers.Click, 'https://valet.example.com/threads/abc123')

  const failed = buildNotification({ event: 'error', threadId: 'a', title: 'Réparer\nla connexion', error: null, baseUrl: base })
  const req2 = buildWebhookRequest('ntfy', null, failed)
  assert.equal(req2.headers.Priority, 'high')
  assert.equal(req2.headers.Title, `=?UTF-8?B?${Buffer.from('Réparer la connexion', 'utf8').toString('base64')}?=`)
})

test('generic payload is signed over the bytes that are sent', () => {
  const unsigned = buildWebhookRequest('generic', null, finished)
  assert.deepEqual(JSON.parse(unsigned.body), {
    event: 'finished',
    threadId: 'abc123',
    title: 'Fix login bug',
    body: 'Finished',
    url: 'https://valet.example.com/threads/abc123',
    at: '2026-09-07T12:00:00.000Z',
  })
  assert.equal(unsigned.headers['x-valet-signature'], undefined)

  const signed = buildWebhookRequest('generic', 'topsecret', finished)
  assert.equal(signed.body, unsigned.body)
  const expected = crypto.createHmac('sha256', 'topsecret').update(signed.body, 'utf8').digest('hex')
  assert.equal(signed.headers['x-valet-signature'], `sha256=${expected}`)
  assert.equal(signPayload(signed.body, 'topsecret'), expected)
})

test('test notification links to the app root', () => {
  const n = testNotification(base, '2026-09-07T12:00:00.000Z')
  assert.equal(n.url, 'https://valet.example.com/')
  assert.equal(n.title, 'Valet')
  assert.equal(n.body, 'Test notification')
})

test('title and error are bounded so every channel gets the same text', () => {
  const long = buildNotification({
    event: 'error',
    threadId: 'a',
    title: 'T'.repeat(400),
    error: `${'stderr line\n'.repeat(500)}`,
    baseUrl: base,
  })
  assert.equal(long.title.length, 120)
  assert.ok(long.title.endsWith('…'))
  assert.ok(long.body.length <= 'Error: '.length + 200)
  assert.ok(long.body.endsWith('…'))
  assert.ok(Buffer.byteLength(buildPushPayload(long)) < 4096)
  // A title that fits is untouched, ellipsis and all.
  assert.equal(buildNotification({ event: 'finished', threadId: 'a', title: 'Fix login', error: null, baseUrl: base }).title, 'Fix login')
})

test('subscription keys must be the sizes RFC 8291 encrypts for', () => {
  const keys = { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') }
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc'
  assert.equal(pushSubscriptionSchema.safeParse({ endpoint, keys }).success, true)
  assert.equal(pushSubscriptionSchema.safeParse({ endpoint, keys: { ...keys, p256dh: 'garbage' } }).success, false)
  assert.equal(pushSubscriptionSchema.safeParse({ endpoint, keys: { ...keys, auth: '' } }).success, false)
})

test('core refuses to POST to addresses that only exist from inside the server', () => {
  assertPostableUrl('https://hooks.slack.com/services/T/B/x')
  assertPostableUrl('http://ntfy:8080/valet')
  for (const url of [
    'http://127.0.0.1:8080/api/health',
    'http://localhost:3000/hook',
    'http://valet.localhost/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.8/private',
    'http://172.17.0.1/private',
    'http://192.168.1.2/private',
    'http://100.100.100.200/metadata',
    'http://0.0.0.0/hook',
    'http://[::1]:8080/hook',
    'http://[fe80::1]/hook',
    'http://[fc00::1]/hook',
    'http://user:pass@example.com/hook',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => assertPostableUrl(url), { status: 400 }, url)
  }
})

test('notification DNS addresses reject private, link-local, and IPv4-mapped targets', async () => {
  assertPublicAddress('8.8.8.8')
  assertPublicAddress('2606:4700:4700::1111')
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '172.20.0.1', '192.168.0.1', '100.64.0.1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) {
    assert.throws(() => assertPublicAddress(address), { status: 400 }, address)
  }
  await assert.rejects(pinnedLookup('http://127.0.0.1:8080'), { status: 400 })
})
