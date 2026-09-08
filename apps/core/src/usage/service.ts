import { and, asc, desc, eq, gte, sql, type SQL } from 'drizzle-orm'
import type {
  RateLimitInfo,
  UsageBucket,
  UsageByModel,
  UsageByProject,
  UsageDay,
  UsageRange,
  UsageRateLimit,
  UsageResponse,
  UsageTotals,
} from '@valet/shared'
import type { Db } from '../db/index.js'
import { projects, threadEvents, threads } from '../db/schema.js'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
/** Beyond this span the series buckets by week, so `all` cannot grow one row per day forever. */
const MAX_DAILY_SPAN = 90

const utcDay = (d: Date): string => d.toISOString().slice(0, 10)

/** Start of the first UTC day the range covers; null for `all`, which starts at the first turn. */
export function rangeStart(range: UsageRange, now: Date): Date | null {
  if (range === 'all') return null
  const days = range === '7d' ? 7 : 30
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * DAY_MS)
}

const ZERO: UsageTotals = { costUsd: null, inputTokens: 0, outputTokens: 0, turns: 0, threads: 0 }

/**
 * Sums rollup groups. Every thread belongs to exactly one project, agent, and model,
 * so summing `threads` across those groupings is still a distinct count — it is not
 * across days, which is why totals are folded from `byProject` and never from `daily`.
 */
export function sumTotals(rows: readonly UsageTotals[]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (acc, r) => ({
      costUsd: r.costUsd === null ? acc.costUsd : (acc.costUsd ?? 0) + r.costUsd,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      turns: acc.turns + r.turns,
      threads: acc.threads + r.threads,
    }),
    ZERO,
  )
}

/** Monday of the UTC week containing `day`, matching Postgres `date_trunc('week', ...)`. */
export function weekStart(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`)
  const sinceMonday = (new Date(t).getUTCDay() + 6) % 7
  return utcDay(new Date(t - sinceMonday * DAY_MS))
}

/** The number of UTC days `from`..`to` covers, both ends included. */
export function spanDays(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1
}

/** The observed buckets padded with zeros so the series has one entry per UTC day or week. */
export function fillBuckets(rows: readonly UsageDay[], from: string, to: string, bucket: UsageBucket): UsageDay[] {
  const seen = new Map(rows.map((r) => [r.day, r]))
  const step = bucket === 'week' ? WEEK_MS : DAY_MS
  const start = bucket === 'week' ? weekStart(from) : from
  const out: UsageDay[] = []
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += step) {
    const day = utcDay(new Date(t))
    out.push(seen.get(day) ?? { day, ...ZERO })
  }
  return out
}

// `payload->'usage'` is SQL NULL when the key is absent and the jsonb literal `null`
// when the turn reported no usage; both compare to NULL/false here and drop out.
const HAS_USAGE = sql`${threadEvents.payload}->'usage' <> 'null'::jsonb`

type MetricRow = { costUsd: string | null; inputTokens: string; outputTokens: string; turns: string; threads: string }

const metrics = {
  // No coalesce: a group where every turn is missing `costUsd` (Codex reports none)
  // must stay null so the UI can say "not tracked" rather than "$0.00".
  costUsd: sql<string | null>`sum((${threadEvents.payload}->'usage'->>'costUsd')::numeric)`,
  inputTokens: sql<string>`coalesce(sum((${threadEvents.payload}->'usage'->>'inputTokens')::numeric), 0)`,
  outputTokens: sql<string>`coalesce(sum((${threadEvents.payload}->'usage'->>'outputTokens')::numeric), 0)`,
  turns: sql<string>`count(*)`,
  threads: sql<string>`count(distinct ${threadEvents.threadId})`,
}

const toTotals = (row: MetricRow): UsageTotals => ({
  costUsd: row.costUsd === null ? null : Number(row.costUsd),
  inputTokens: Number(row.inputTokens),
  outputTokens: Number(row.outputTokens),
  turns: Number(row.turns),
  threads: Number(row.threads),
})

const BUCKET_SQL: Record<UsageBucket, SQL<string>> = {
  day: sql<string>`to_char(${threadEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
  week: sql<string>`to_char(date_trunc('week', ${threadEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
}

const firstDay = sql<string | null>`to_char(min(${threadEvents.createdAt}) at time zone 'UTC', 'YYYY-MM-DD')`

export class UsageService {
  constructor(private readonly db: Db) {}

  async summary(range: UsageRange, now = new Date()): Promise<UsageResponse> {
    const since = rangeStart(range, now)
    const scope = and(eq(threadEvents.type, 'turn.end'), HAS_USAGE, ...(since ? [gte(threadEvents.createdAt, since)] : []))
    const to = utcDay(now)
    const from = since ? utcDay(since) : await this.firstDay(scope, to)
    const bucket: UsageBucket = spanDays(from, to) > MAX_DAILY_SPAN ? 'week' : 'day'
    const day = BUCKET_SQL[bucket]

    // Rows come back in identity order; the client sorts them by whichever metric it shows.
    const [projectRows, modelRows, dayRows, rateLimits] = await Promise.all([
      this.db
        .select({ projectId: threads.projectId, projectName: projects.name, ...metrics })
        .from(threadEvents)
        .innerJoin(threads, eq(threads.id, threadEvents.threadId))
        .innerJoin(projects, eq(projects.id, threads.projectId))
        .where(scope)
        .groupBy(threads.projectId, projects.name)
        .orderBy(asc(projects.name), asc(threads.projectId)),
      this.db
        .select({ agent: threads.agent, model: threads.model, ...metrics })
        .from(threadEvents)
        .innerJoin(threads, eq(threads.id, threadEvents.threadId))
        .where(scope)
        .groupBy(threads.agent, threads.model)
        .orderBy(asc(threads.agent), asc(threads.model)),
      this.db.select({ day, ...metrics }).from(threadEvents).where(scope).groupBy(day).orderBy(asc(day)),
      this.rateLimits(now),
    ])

    const byProject: UsageByProject[] = projectRows.map((r) => ({ projectId: r.projectId, projectName: r.projectName, ...toTotals(r) }))
    const byModel: UsageByModel[] = modelRows.map((r) => ({ agent: r.agent, model: r.model, ...toTotals(r) }))
    const days: UsageDay[] = dayRows.map((r) => ({ day: r.day, ...toTotals(r) }))

    return {
      range,
      since: since?.toISOString() ?? null,
      totals: sumTotals(byProject),
      byProject,
      byModel,
      bucket,
      daily: fillBuckets(days, from, to, bucket),
      rateLimits,
    }
  }

  /** The UTC day of the oldest turn in scope, or `fallback` when the scope holds no turns. */
  private async firstDay(scope: SQL | undefined, fallback: string): Promise<string> {
    const [row] = await this.db.select({ day: firstDay }).from(threadEvents).where(scope)
    return row?.day ?? fallback
  }

  /**
   * The newest `usage` event carrying rate limits, per agent; empty when no agent has reported any.
   * A window past its reset says nothing about the current window, so it is dropped rather than
   * shown as current state.
   */
  private async rateLimits(now: Date): Promise<UsageRateLimit[]> {
    const rows = await this.db
      .selectDistinctOn([threads.agent], {
        agent: threads.agent,
        limits: sql<RateLimitInfo[]>`${threadEvents.payload}->'rateLimits'`,
        observedAt: threadEvents.createdAt,
      })
      .from(threadEvents)
      .innerJoin(threads, eq(threads.id, threadEvents.threadId))
      .where(and(eq(threadEvents.type, 'usage'), sql`${threadEvents.payload}->'rateLimits' <> 'null'::jsonb`))
      .orderBy(threads.agent, desc(threadEvents.id))

    return rows.flatMap((row) =>
      row.limits
        .filter((limit) => limit.resetsAt === null || Date.parse(limit.resetsAt) > now.getTime())
        .map((limit) => ({ ...limit, agent: row.agent, observedAt: row.observedAt.toISOString() })),
    )
  }
}
