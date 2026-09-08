import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadEvent } from '@valet/shared'
import { REDACTION_MARKER, SecretRedactor, activeSecrets, redactEvent, redactString } from '../src/events/redact.js'

const SECRET = 'sk-test-01234567'
const OTHER = 'hunter2hunter2'

test('redacts secrets in text events', () => {
  const event: ThreadEvent = { type: 'text.end', turnId: 't1', itemId: 'i1', text: `the key is ${SECRET}.` }
  const out = redactEvent(event, [SECRET])
  assert.deepEqual(out, { type: 'text.end', turnId: 't1', itemId: 'i1', text: `the key is ${REDACTION_MARKER}.` })
})

test('redacts every occurrence and every secret, nested in tool input', () => {
  const event: ThreadEvent = {
    type: 'tool.input',
    turnId: 't1',
    itemId: 'i1',
    title: 'bash',
    input: { command: `curl -H "auth: ${SECRET}" https://x/${OTHER}`, env: [{ TOKEN: SECRET }] },
  }
  const out = redactEvent(event, [SECRET, OTHER]) as Extract<ThreadEvent, { type: 'tool.input' }>
  assert.deepEqual(out.input, {
    command: `curl -H "auth: ${REDACTION_MARKER}" https://x/${REDACTION_MARKER}`,
    env: [{ TOKEN: REDACTION_MARKER }],
  })
})

test('redacts a secret embedded in a longer token', () => {
  const event: ThreadEvent = {
    type: 'tool.output',
    turnId: 't1',
    itemId: 'i1',
    output: `Authorization=Bearer${SECRET}xyz`,
    isError: false,
    exitCode: 0,
    fileChanges: null,
  }
  const out = redactEvent(event, [SECRET]) as Extract<ThreadEvent, { type: 'tool.output' }>
  assert.equal(out.output, `Authorization=Bearer${REDACTION_MARKER}xyz`)
})

test('redacts strings outside events, such as the thread title', () => {
  assert.equal(redactString(`Call the API with ${SECRET}`, [SECRET]), `Call the API with ${REDACTION_MARKER}`)
  assert.equal(redactString('Call the API', [SECRET]), 'Call the API')
  assert.equal(redactString(SECRET, []), SECRET)
})

test('leaves events without a match untouched', () => {
  const event: ThreadEvent = { type: 'log', level: 'info', message: 'Creating sandbox', at: '2026-09-07T00:00:00.000Z' }
  assert.equal(redactEvent(event, [SECRET]), event)
  assert.equal(redactEvent(event, []), event)
})

test('short values are never redacted', () => {
  assert.deepEqual(activeSecrets(['true', '1234567', OTHER, SECRET]), [SECRET, OTHER])
  const event: ThreadEvent = { type: 'log', level: 'info', message: 'PORT=3000 and DEBUG=true', at: 'now' }
  assert.equal(redactEvent(event, activeSecrets(['3000', 'true'])), event)
})

test('caches per thread and reloads after the project changes', async () => {
  let values = [SECRET]
  let loads = 0
  const redactor = new SecretRedactor(async (threadId) => {
    loads += 1
    return threadId === 'gone' ? null : { projectId: 'p1', values }
  })
  const event: ThreadEvent = { type: 'log', level: 'info', message: `token ${SECRET} and ${OTHER}`, at: 'now' }

  const first = (await redactor.apply('t1', event)) as Extract<ThreadEvent, { type: 'log' }>
  assert.equal(first.message, `token ${REDACTION_MARKER} and ${OTHER}`)
  await redactor.apply('t1', event)
  assert.equal(loads, 1)

  values = [SECRET, OTHER]
  redactor.invalidate('p2')
  await redactor.apply('t1', event)
  assert.equal(loads, 1)

  redactor.invalidate('p1')
  const second = (await redactor.apply('t1', event)) as Extract<ThreadEvent, { type: 'log' }>
  assert.equal(second.message, `token ${REDACTION_MARKER} and ${REDACTION_MARKER}`)
  assert.equal(loads, 2)

  // A thread with no row is not cached, so the answer is not kept once it exists.
  assert.equal(await redactor.apply('gone', event), event)
  assert.equal(loads, 3)
})

test('the thread row\'s error is redacted against the same cached values', async () => {
  let loads = 0
  const redactor = new SecretRedactor(async (threadId) => {
    loads += 1
    return threadId === 'gone' ? null : { projectId: 'p1', values: [SECRET] }
  })

  assert.equal(await redactor.applyToString('t1', `git failed: ${SECRET}`), `git failed: ${REDACTION_MARKER}`)
  await redactor.apply('t1', { type: 'log', level: 'info', message: 'x', at: 'now' })
  assert.equal(loads, 1)
  // A thread with no row has nothing to redact against, and the string is untouched.
  assert.equal(await redactor.applyToString('gone', SECRET), SECRET)
})

test('a project with redaction disabled keeps its output', async () => {
  const redactor = new SecretRedactor(async () => ({ projectId: 'p1', values: [] }))
  const event: ThreadEvent = { type: 'log', level: 'info', message: `token ${SECRET}`, at: 'now' }
  assert.equal(await redactor.apply('t1', event), event)
})
