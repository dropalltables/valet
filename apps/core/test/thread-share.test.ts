import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import type { ChangesResponse, Thread } from '@valet/shared'
import { loadConfig } from '../src/config.js'
import { Cipher } from '../src/crypto.js'
import type { Db } from '../src/db/index.js'
import { notFound } from '../src/errors.js'
import { PortalAuth } from '../src/portals/auth.js'
import type { ThreadService } from '../src/threads/service.js'
import { ThreadShares } from '../src/threads/share.js'
import { forShared } from '../src/ws/index.js'

const THREAD = 'abc123'
const MAX_FAILURES = 100

const EMPTY_CHANGES: ChangesResponse = { stats: { files: 0, additions: 0, deletions: 0 }, files: [], commits: [], dirty: false }

function config() {
  return loadConfig({ DATABASE_URL: 'postgres://unused', VALET_SECRET_KEY: crypto.randomBytes(32).toString('base64'), VALET_BASE_URL: 'https://valet.example.com' })
}

function shares(): { shares: ThreadShares; cipher: Cipher; changeCalls: () => number } {
  const cfg = config()
  const rows = new Map<string, { shared: boolean; generation: number }>([[THREAD, { shared: false, generation: 0 }]])
  let changeCalls = 0
  const threads = {
    shareState: async (id: string) => {
      const row = rows.get(id)
      if (!row) throw notFound('thread')
      return { ...row }
    },
    setShare: async (id: string, state: { shared: boolean; generation: number }) => {
      rows.set(id, state)
    },
    changes: async () => {
      changeCalls += 1
      return EMPTY_CHANGES
    },
  } as unknown as ThreadService
  const cipher = new Cipher(cfg.VALET_SECRET_KEY)
  return { shares: new ThreadShares(cfg, cipher, threads), cipher, changeCalls: () => changeCalls }
}

function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1)
}

test('a minted link resolves to its thread and stays valid across re-shares', async () => {
  const { shares: s } = shares()
  assert.deepEqual(await s.status(THREAD), { shared: false, url: null })

  const created = await s.create(THREAD)
  assert.equal(created.shared, true)
  assert.match(created.url ?? '', /^https:\/\/valet\.example\.com\/s\/[\w-]+$/)
  assert.equal(await s.resolve(tokenOf(created.url ?? '')), THREAD)

  // Re-sharing keeps the generation, so a link already handed out keeps working.
  const again = await s.create(THREAD)
  assert.equal(await s.resolve(tokenOf(again.url ?? '')), THREAD)
  assert.equal(await s.resolve(tokenOf(created.url ?? '')), THREAD)
  const status = await s.status(THREAD)
  assert.equal(status.shared, true)
  assert.equal(await s.resolve(tokenOf(status.url ?? '')), THREAD)
})

test('revoking kills every link issued so far; the next link is a new one', async () => {
  const { shares: s } = shares()
  const first = tokenOf((await s.create(THREAD)).url ?? '')
  await s.revoke(THREAD)

  assert.equal(await s.resolve(first), null)
  assert.deepEqual(await s.status(THREAD), { shared: false, url: null })

  const second = tokenOf((await s.create(THREAD)).url ?? '')
  assert.notEqual(second, first)
  assert.equal(await s.resolve(second), THREAD)
  assert.equal(await s.resolve(first), null)
})

test('revoking closes the streams already open on the link', async () => {
  const { shares: s } = shares()
  await s.create(THREAD)
  const closed: string[] = []
  s.watch(THREAD, () => closed.push('viewer'))
  s.watch('other', () => closed.push('other thread'))
  const detached = s.watch(THREAD, () => closed.push('gone'))
  detached()

  await s.revoke(THREAD)
  assert.deepEqual(closed, ['viewer'])
})

test('malformed, forged, and unknown tokens resolve to null', async () => {
  const { shares: s } = shares()
  const valid = tokenOf((await s.create(THREAD)).url ?? '')
  const flipped = Buffer.from(valid, 'base64url')
  flipped.writeUInt8(flipped[flipped.length - 1]! ^ 0xff, flipped.length - 1)

  for (const raw of ['', 'not-a-token', valid.slice(0, -4), flipped.toString('base64url')]) {
    assert.equal(await s.resolve(raw), null)
  }
  // A token minted with a different key never decrypts, however well-formed it looks.
  const other = shares().shares
  assert.equal(await s.resolve(tokenOf((await other.create(THREAD)).url ?? '')), null)
})

test('a portal token is not a share token, and a share token is not a portal token', async () => {
  const { shares: s, cipher } = shares()
  const shareUrl = (await s.create(THREAD)).url ?? ''
  const portalAuth = new PortalAuth(cipher, true, null as unknown as Db)

  // Same cipher, same thread, same generation, and one is even unexpired.
  for (const scope of ['owner', 'share'] as const) {
    for (const exp of [Date.now() + 60_000, Date.now() - 1]) {
      const raw = portalAuth.mint({ v: 1, t: THREAD, p: 3000, s: scope, g: 0, exp, ret: '/' })
      assert.equal(await s.resolve(raw), null)
    }
  }
  assert.equal(portalAuth.read(tokenOf(shareUrl)), null)
})

test('attempts are refused once the budget is spent, and allowed again a minute later', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const { shares: s } = shares()
  const valid = tokenOf((await s.create(THREAD)).url ?? '')

  for (let i = 0; i < MAX_FAILURES; i += 1) assert.equal(await s.resolve('guess'), null)
  assert.equal(await s.resolve(valid), null)

  t.mock.timers.tick(60_000)
  assert.equal(await s.resolve(valid), THREAD)
})

test('link holders share one diff computation per poll interval', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const { shares: s, changeCalls } = shares()

  assert.deepEqual(await Promise.all([s.changes(THREAD), s.changes(THREAD)]), [EMPTY_CHANGES, EMPTY_CHANGES])
  assert.equal(changeCalls(), 1)

  t.mock.timers.tick(4_999)
  await s.changes(THREAD)
  assert.equal(changeCalls(), 1)

  t.mock.timers.tick(1)
  await s.changes(THREAD)
  assert.equal(changeCalls(), 2)
})

const THREAD_ROW: Thread = {
  id: THREAD,
  projectId: 'p1',
  title: 'Add sharing',
  agent: 'claude',
  model: 'sonnet',
  permissions: 'ask',
  status: 'running',
  error: null,
  branch: 'valet/add-sharing-1a2b',
  baseBranch: 'main',
  containerId: 'c1',
  agentSessionId: 'sess-1',
  pr: null,
  costUsd: 1.25,
  lastActivityAt: '2026-09-07T00:00:00.000Z',
  createdAt: '2026-09-07T00:00:00.000Z',
  archivedAt: null,
}

test('a link holder sees the transcript without cost, sandbox handles, ports, or services', () => {
  const thread = forShared({ t: 'thread', thread: THREAD_ROW })
  assert.deepEqual(thread, { t: 'thread', thread: { ...THREAD_ROW, costUsd: null, containerId: null, agentSessionId: null } })

  assert.equal(forShared({ t: 'portals', portals: [] }), null)
  assert.equal(forShared({ t: 'services', services: [] }), null)
  assert.equal(forShared({ t: 'event', seq: 3, event: { type: 'session', agentSessionId: 'sess-1' } }), null)

  const usage = forShared({
    t: 'event',
    seq: 4,
    event: { type: 'usage', turnId: 't1', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.5 }, rateLimits: [{ window: 'five_hour', utilization: 0.4, resetsAt: null }] },
  })
  assert.deepEqual(usage, { t: 'event', seq: 4, event: { type: 'usage', turnId: 't1', usage: { inputTokens: 10, outputTokens: 2 }, rateLimits: null } })

  const end = forShared({
    t: 'event',
    seq: 5,
    event: { type: 'turn.end', turnId: 't1', status: 'completed', error: null, usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.5 }, at: '2026-09-07T00:00:00.000Z' },
  })
  assert.deepEqual(end, {
    t: 'event',
    seq: 5,
    event: { type: 'turn.end', turnId: 't1', status: 'completed', error: null, usage: { inputTokens: 10, outputTokens: 2 }, at: '2026-09-07T00:00:00.000Z' },
  })

  const text = { t: 'event', seq: 6, event: { type: 'text.end', turnId: 't1', itemId: 'i1', text: 'done' } } as const
  assert.deepEqual(forShared(text), text)
  assert.deepEqual(forShared({ t: 'live' }), { t: 'live' })
})
