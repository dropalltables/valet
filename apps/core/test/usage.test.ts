import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { RateLimitInfo, UsageInfo } from '@valet/shared'
import { sql } from 'drizzle-orm'
import { createDb, type Db } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { projects, threadEvents, threads } from '../src/db/schema.js'
import { UsageService, fillBuckets, rangeStart, spanDays, sumTotals, weekStart } from '../src/usage/service.js'

test('range start covers whole UTC days', () => {
  const now = new Date('2026-09-07T18:30:00Z')
  assert.equal(rangeStart('7d', now)?.toISOString(), '2026-09-01T00:00:00.000Z')
  assert.equal(rangeStart('30d', now)?.toISOString(), '2026-08-09T00:00:00.000Z')
  assert.equal(rangeStart('all', now), null)
})

test('weeks start on Monday, as Postgres truncates them', () => {
  assert.equal(weekStart('2026-09-07'), '2026-09-07')
  assert.equal(weekStart('2026-09-13'), '2026-09-07')
  assert.equal(weekStart('2026-09-06'), '2026-08-31')
  assert.equal(spanDays('2026-09-01', '2026-09-01'), 1)
  assert.equal(spanDays('2026-09-01', '2026-09-07'), 7)
})

test('empty buckets are filled by day and by week', () => {
  const zero = { costUsd: null, inputTokens: 0, outputTokens: 0, turns: 0, threads: 0 }
  const weekly = fillBuckets([{ day: '2026-09-07', ...zero, turns: 5 }], '2026-06-03', '2026-09-13', 'week')
  assert.equal(weekly.length, 15)
  assert.equal(weekly[0]?.day, '2026-06-01')
  assert.equal(weekly.at(-1)?.day, '2026-09-07')
  assert.equal(weekly.find((w) => w.day === '2026-09-07')?.turns, 5)
})

test('empty days are filled and totals keep untracked cost null', () => {
  const zero = { costUsd: null, inputTokens: 0, outputTokens: 0, turns: 0, threads: 0 }
  const filled = fillBuckets([{ day: '2026-09-03', ...zero, turns: 2, costUsd: 1 }], '2026-09-01', '2026-09-04', 'day')
  assert.deepEqual(
    filled.map((d) => [d.day, d.turns]),
    [
      ['2026-09-01', 0],
      ['2026-09-02', 0],
      ['2026-09-03', 2],
      ['2026-09-04', 0],
    ],
  )
  assert.equal(sumTotals([zero, { ...zero, turns: 3 }]).costUsd, null)
  assert.equal(sumTotals([{ ...zero, costUsd: 0.5 }, zero]).costUsd, 0.5)
  assert.equal(sumTotals([{ ...zero, costUsd: 0.5, threads: 1 }, { ...zero, costUsd: 0.25, threads: 2 }]).threads, 3)
})

const databaseUrl = process.env.VALET_TEST_DATABASE_URL
const dbTest = { skip: databaseUrl ? false : 'set VALET_TEST_DATABASE_URL to a scratch Postgres' }

let db: Db
let close: () => Promise<void>

before(async () => {
  if (!databaseUrl) return
  const created = createDb(databaseUrl)
  db = created.db
  close = () => created.pool.end()
  await runMigrations(db)
  await db.execute(sql`truncate table ${threadEvents}, ${threads}, ${projects} restart identity cascade`)
  await seed(db)
})

after(async () => {
  if (close) await close()
})

/**
 * Two projects, three threads, and turns on two UTC days, including a Codex thread
 * whose turns report no cost and a turn whose usage is null.
 */
async function seed(db: Db): Promise<void> {
  await db.insert(projects).values([
    { id: 'p1', name: 'Alpha', source: 'blank', defaultBranch: 'main' },
    { id: 'p2', name: 'Beta', source: 'blank', defaultBranch: 'main' },
  ])
  const thread = (id: string, projectId: string, agent: 'claude' | 'codex', model: string) => ({
    id,
    projectId,
    title: id,
    agent,
    model,
    permissions: 'bypassPermissions',
    status: 'idle' as const,
    branch: `valet/${id}`,
    baseBranch: 'main',
    volumeName: `vol-${id}`,
    supervisorTokenEnc: 'x',
    firstPrompt: 'hi',
  })
  await db
    .insert(threads)
    .values([thread('t1', 'p1', 'claude', 'opus'), thread('t2', 'p1', 'claude', 'sonnet'), thread('t3', 'p2', 'codex', 'gpt-6')])

  let seq = 0
  const turn = (threadId: string, day: string, usage: UsageInfo | null) => ({
    threadId,
    seq: seq++,
    type: 'turn.end',
    payload: { type: 'turn.end', turnId: `turn-${seq}`, status: 'completed', error: null, usage, at: `${day}T12:00:00.000Z` },
    createdAt: new Date(`${day}T12:00:00.000Z`),
  })
  await db.insert(threadEvents).values([
    turn('t1', '2026-09-01', { inputTokens: 100, outputTokens: 10, costUsd: 0.5 }),
    turn('t1', '2026-09-03', { inputTokens: 200, outputTokens: 20, costUsd: 1.25 }),
    turn('t2', '2026-09-03', { inputTokens: 50, outputTokens: 5, costUsd: 0.25 }),
    turn('t2', '2026-09-03', null),
    turn('t3', '2026-09-03', { inputTokens: 900, outputTokens: 90 }),
    turn('t3', '2026-09-03', { inputTokens: 100, outputTokens: 10 }),
  ])

  const limits: RateLimitInfo[] = [
    { window: 'five_hour', utilization: 0.42, resetsAt: '2026-09-03T17:00:00.000Z' },
    { window: 'seven_day', utilization: 0.11, resetsAt: null },
  ]
  await db.insert(threadEvents).values([
    {
      threadId: 't1',
      seq: seq++,
      type: 'usage',
      payload: { type: 'usage', turnId: 'turn-1', usage: { inputTokens: 1, outputTokens: 1 }, rateLimits: null },
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
    },
    {
      threadId: 't1',
      seq: seq++,
      type: 'usage',
      payload: { type: 'usage', turnId: 'turn-2', usage: { inputTokens: 1, outputTokens: 1 }, rateLimits: limits },
      createdAt: new Date('2026-09-03T12:00:00.000Z'),
    },
  ])
}

test('rolls up turns by project, agent and model, and day', dbTest, async () => {
  const res = await new UsageService(db).summary('7d', new Date('2026-09-04T09:00:00Z'))

  assert.deepEqual(res.totals, { costUsd: 2, inputTokens: 1350, outputTokens: 135, turns: 5, threads: 3 })

  assert.deepEqual(
    res.byProject.map((p) => [p.projectName, p.costUsd, p.turns, p.threads]),
    [
      ['Alpha', 2, 3, 2],
      ['Beta', null, 2, 1],
    ],
  )

  assert.deepEqual(
    res.byModel.map((m) => [m.agent, m.model, m.costUsd, m.inputTokens, m.turns]),
    [
      ['claude', 'opus', 1.75, 300, 2],
      ['claude', 'sonnet', 0.25, 50, 1],
      ['codex', 'gpt-6', null, 1000, 2],
    ],
  )

  assert.deepEqual(
    res.daily.map((d) => [d.day, d.costUsd, d.turns, d.threads]),
    [
      ['2026-08-29', null, 0, 0],
      ['2026-08-30', null, 0, 0],
      ['2026-08-31', null, 0, 0],
      ['2026-09-01', 0.5, 1, 1],
      ['2026-09-02', null, 0, 0],
      ['2026-09-03', 1.5, 4, 3],
      ['2026-09-04', null, 0, 0],
    ],
  )
})

test('the range window excludes older turns', dbTest, async () => {
  const res = await new UsageService(db).summary('7d', new Date('2026-09-08T09:00:00Z'))
  assert.equal(res.totals.turns, 4)
  assert.equal(res.totals.costUsd, 1.5)
  assert.equal(res.daily.length, 7)
  assert.equal(res.daily[0]?.day, '2026-09-02')

  const all = await new UsageService(db).summary('all', new Date('2026-09-08T09:00:00Z'))
  assert.equal(all.since, null)
  assert.equal(all.totals.turns, 5)
  assert.equal(all.bucket, 'day')
  assert.equal(all.daily[0]?.day, '2026-09-01')
  assert.equal(all.daily.at(-1)?.day, '2026-09-08')
})

test('a long all-time span buckets the series by week', dbTest, async () => {
  const res = await new UsageService(db).summary('all', new Date('2027-01-04T09:00:00Z'))
  assert.equal(res.bucket, 'week')
  assert.equal(res.daily[0]?.day, '2026-08-31')
  assert.equal(res.daily.at(-1)?.day, '2027-01-04')
  assert.equal(res.daily.length, 19)
  const active = res.daily.filter((d) => d.turns > 0)
  assert.deepEqual(
    active.map((d) => [d.day, d.turns, d.threads, d.costUsd]),
    [['2026-08-31', 5, 3, 2]],
  )
  assert.equal(sumTotals(res.daily).turns, res.totals.turns)
})

test('reports the newest rate-limit windows per agent', dbTest, async () => {
  const res = await new UsageService(db).summary('all', new Date('2026-09-03T14:00:00Z'))
  assert.deepEqual(res.rateLimits, [
    { agent: 'claude', window: 'five_hour', utilization: 0.42, resetsAt: '2026-09-03T17:00:00.000Z', observedAt: '2026-09-03T12:00:00.000Z' },
    { agent: 'claude', window: 'seven_day', utilization: 0.11, resetsAt: null, observedAt: '2026-09-03T12:00:00.000Z' },
  ])
})

test('drops rate-limit windows that have already reset', dbTest, async () => {
  const res = await new UsageService(db).summary('all', new Date('2026-09-08T09:00:00Z'))
  assert.deepEqual(
    res.rateLimits.map((l) => l.window),
    ['seven_day'],
  )
})
