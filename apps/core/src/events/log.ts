import { and, asc, desc, eq, gt, inArray, max, sql } from 'drizzle-orm'
import type { GlobalFrame, Portal, Project, Service, StoredEvent, StreamFrame, Thread, ThreadEvent, ThreadListItem } from '@valet/shared'
import type { Db } from '../db/index.js'
import { threadEvents } from '../db/schema.js'
import { logger } from '../logger.js'

const log = logger('events')

export const COALESCE_MS = 250

type DeltaEvent = Extract<ThreadEvent, { type: 'text.delta' | 'reasoning.delta' | 'tool.outputDelta' }>

function isDelta(e: ThreadEvent): e is DeltaEvent {
  return e.type === 'text.delta' || e.type === 'reasoning.delta' || e.type === 'tool.outputDelta'
}

type ThreadState = {
  chain: Promise<void>
  nextSeq: number | null
  /** Insertion-ordered so a flush replays deltas in arrival order. */
  pending: Map<string, DeltaEvent>
  timer: NodeJS.Timeout | null
  subscribers: Set<(frame: StreamFrame) => void>
}

/**
 * Append-only log per thread with monotonic `seq`, delta coalescing, and fan-out.
 *
 * Deltas for one item are merged and written at most every COALESCE_MS, or as soon
 * as any non-delta event for the thread arrives, so persisted order equals arrival
 * order and live subscribers see exactly what a replay would.
 */
export class EventLog {
  private readonly threads = new Map<string, ThreadState>()
  private readonly globalSubscribers = new Set<(frame: GlobalFrame) => void>()

  constructor(private readonly db: Db) {}

  private state(threadId: string): ThreadState {
    let s = this.threads.get(threadId)
    if (!s) {
      s = { chain: Promise.resolve(), nextSeq: null, pending: new Map(), timer: null, subscribers: new Set() }
      this.threads.set(threadId, s)
    }
    return s
  }

  private enqueue(threadId: string, op: () => Promise<void>): Promise<void> {
    const s = this.state(threadId)
    const run = s.chain.then(op, op)
    s.chain = run.catch((err) => log.error('append failed', { threadId, err }))
    return run
  }

  append(threadId: string, event: ThreadEvent): Promise<void> {
    return this.enqueue(threadId, async () => {
      const s = this.state(threadId)
      if (isDelta(event)) {
        const key = `${event.type}:${event.itemId}`
        const cur = s.pending.get(key)
        if (cur) cur.delta += event.delta
        else s.pending.set(key, { ...event })
        if (!s.timer) {
          s.timer = setTimeout(() => {
            s.timer = null
            void this.enqueue(threadId, () => this.flushPending(threadId))
          }, COALESCE_MS)
        }
        return
      }
      await this.flushPending(threadId)
      await this.persist(threadId, event)
    })
  }

  /** Writes buffered deltas now; resolves after they are persisted. */
  flush(threadId: string): Promise<void> {
    return this.enqueue(threadId, () => this.flushPending(threadId))
  }

  private async flushPending(threadId: string): Promise<void> {
    const s = this.state(threadId)
    if (s.timer) {
      clearTimeout(s.timer)
      s.timer = null
    }
    if (s.pending.size === 0) return
    const batch = [...s.pending.values()]
    s.pending.clear()
    for (const e of batch) await this.persist(threadId, e)
  }

  private async persist(threadId: string, event: ThreadEvent): Promise<void> {
    const s = this.state(threadId)
    if (s.nextSeq === null) {
      const [row] = await this.db
        .select({ max: max(threadEvents.seq) })
        .from(threadEvents)
        .where(eq(threadEvents.threadId, threadId))
      s.nextSeq = (row?.max ?? 0) + 1
    }
    const seq = s.nextSeq
    await this.db.insert(threadEvents).values({ threadId, seq, type: event.type, payload: event })
    s.nextSeq = seq + 1
    this.fanout(threadId, { t: 'event', seq, event })
  }

  private fanout(threadId: string, frame: StreamFrame): void {
    const s = this.threads.get(threadId)
    if (!s) return
    for (const cb of s.subscribers) {
      try {
        cb(frame)
      } catch (err) {
        log.warn('subscriber threw', { threadId, err })
      }
    }
  }

  async replay(threadId: string, since: number, limit: number): Promise<{ events: StoredEvent[]; hasMore: boolean }> {
    const rows = await this.db
      .select({ seq: threadEvents.seq, payload: threadEvents.payload })
      .from(threadEvents)
      .where(and(eq(threadEvents.threadId, threadId), gt(threadEvents.seq, since)))
      .orderBy(asc(threadEvents.seq))
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    return {
      events: page.map((r) => ({ seq: r.seq, event: r.payload as ThreadEvent })),
      hasMore: rows.length > limit,
    }
  }

  /**
   * The last turn when it has no `turn.end` yet, with its unanswered permission
   * requests. Used after a restart to close what the previous process left open.
   */
  async openTurn(threadId: string): Promise<{ turnId: string; pendingPermissions: string[] } | null> {
    const [last] = await this.db
      .select({ type: threadEvents.type, payload: threadEvents.payload })
      .from(threadEvents)
      .where(
        and(
          eq(threadEvents.threadId, threadId),
          inArray(threadEvents.type, ['turn.start', 'turn.end']),
          sql`coalesce(${threadEvents.payload}->>'mode', '') <> 'steer'`,
        ),
      )
      .orderBy(desc(threadEvents.seq))
      .limit(1)
    if (!last || last.type !== 'turn.start') return null
    const turnId = (last.payload as Extract<ThreadEvent, { type: 'turn.start' }>).turnId
    const requests = await this.db
      .select({ type: threadEvents.type, payload: threadEvents.payload })
      .from(threadEvents)
      .where(
        and(
          eq(threadEvents.threadId, threadId),
          inArray(threadEvents.type, ['permission.request', 'permission.response']),
          sql`${threadEvents.payload}->>'turnId' = ${turnId}`,
        ),
      )
      .orderBy(asc(threadEvents.seq))
    const pending = new Set<string>()
    for (const r of requests) {
      const requestId = (r.payload as { requestId: string }).requestId
      if (r.type === 'permission.request') pending.add(requestId)
      else pending.delete(requestId)
    }
    return { turnId, pendingPermissions: [...pending] }
  }

  subscribe(threadId: string, cb: (frame: StreamFrame) => void): () => void {
    const s = this.state(threadId)
    s.subscribers.add(cb)
    return () => {
      s.subscribers.delete(cb)
    }
  }

  subscribeGlobal(cb: (frame: GlobalFrame) => void): () => void {
    this.globalSubscribers.add(cb)
    return () => {
      this.globalSubscribers.delete(cb)
    }
  }

  private fanoutGlobal(frame: GlobalFrame): void {
    for (const cb of this.globalSubscribers) {
      try {
        cb(frame)
      } catch (err) {
        log.warn('global subscriber threw', { err })
      }
    }
  }

  publishThread(thread: ThreadListItem): void {
    const row: Thread = { ...thread }
    delete (row as Partial<ThreadListItem>).projectName
    delete (row as Partial<ThreadListItem>).diffStats
    this.fanout(thread.id, { t: 'thread', thread: row })
    this.fanoutGlobal({ t: 'thread', thread })
  }

  publishPortals(threadId: string, portals: Portal[]): void {
    this.fanout(threadId, { t: 'portals', portals })
  }

  publishServices(threadId: string, services: Service[]): void {
    this.fanout(threadId, { t: 'services', services })
  }

  publishThreadDeleted(id: string): void {
    this.fanoutGlobal({ t: 'thread.deleted', id })
    this.forget(id)
  }

  publishProject(project: Project): void {
    this.fanoutGlobal({ t: 'project', project })
  }

  publishProjectDeleted(id: string): void {
    this.fanoutGlobal({ t: 'project.deleted', id })
  }

  /** Drops in-memory state; subscribers are closed by their sockets. */
  forget(threadId: string): void {
    const s = this.threads.get(threadId)
    if (!s) return
    if (s.timer) clearTimeout(s.timer)
    this.threads.delete(threadId)
  }
}
