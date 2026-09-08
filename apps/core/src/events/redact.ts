import { and, eq } from 'drizzle-orm'
import type { ThreadEvent } from '@valet/shared'
import type { Cipher } from '../crypto.js'
import type { Db } from '../db/index.js'
import { projectEnvVars, projects, threads } from '../db/schema.js'

export const REDACTION_MARKER = '[REDACTED:valet]'

/** Shorter values occur too often in ordinary output to replace blindly. */
export const MIN_SECRET_LENGTH = 8

/** The secret values in force for a thread; empty when the project disabled redaction. */
export type ThreadSecrets = { projectId: string; values: string[] }

/** Replaces every occurrence of every secret; the string comes back unchanged when none matched. */
export function redactString(value: string, secrets: readonly string[]): string {
  let out = value
  for (const secret of secrets) out = out.split(secret).join(REDACTION_MARKER)
  return out
}

function redactUnknown(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactString(value, secrets)
  if (Array.isArray(value)) {
    const items = value.map((item) => redactUnknown(item, secrets))
    return items.some((item, i) => item !== value[i]) ? items : value
  }
  if (value !== null && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      const next = redactUnknown(v, secrets)
      if (next !== v) changed = true
      out[key] = next
    }
    return changed ? out : value
  }
  return value
}

/**
 * Replaces every occurrence of every secret in the event's strings, however deeply
 * nested (tool input is arbitrary JSON). The event is returned unchanged when
 * nothing matched, so the common case copies nothing.
 */
export function redactEvent(event: ThreadEvent, secrets: readonly string[]): ThreadEvent {
  if (secrets.length === 0) return event
  return redactUnknown(event, secrets) as ThreadEvent
}

/**
 * The values worth replacing, longest first so a secret containing another still
 * redacts as one span. Short values occur verbatim in ordinary output too often.
 */
export function activeSecrets(values: readonly string[]): string[] {
  return values.filter((v) => v.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length)
}

/** Secret project variables long enough to redact; empty when the project turned redaction off. */
export async function loadProjectSecrets(db: Db, cipher: Cipher, projectId: string): Promise<string[]> {
  const [project] = await db.select({ redactSecrets: projects.redactSecrets }).from(projects).where(eq(projects.id, projectId))
  if (!project?.redactSecrets) return []
  const rows = await db
    .select({ valueEnc: projectEnvVars.valueEnc })
    .from(projectEnvVars)
    .where(and(eq(projectEnvVars.projectId, projectId), eq(projectEnvVars.kind, 'secret')))
  return activeSecrets(rows.map((r) => cipher.decrypt(r.valueEnc)))
}

/** The same values, for the thread's project; null when the thread has no row yet. */
export async function loadThreadSecrets(db: Db, cipher: Cipher, threadId: string): Promise<ThreadSecrets | null> {
  const [thread] = await db.select({ projectId: threads.projectId }).from(threads).where(eq(threads.id, threadId))
  if (!thread) return null
  return { projectId: thread.projectId, values: await loadProjectSecrets(db, cipher, thread.projectId) }
}

/**
 * Keeps each thread's secret values in memory (the event log consults them on every
 * persisted event) and drops them when the project's variables change.
 */
export class SecretRedactor {
  private readonly cache = new Map<string, ThreadSecrets>()

  constructor(private readonly load: (threadId: string) => Promise<ThreadSecrets | null>) {}

  async apply(threadId: string, event: ThreadEvent): Promise<ThreadEvent> {
    const cached = this.cache.get(threadId)
    if (cached) return redactEvent(event, cached.values)
    // A thread with no row has nothing to redact against, and caching that answer
    // would keep it after the row appears.
    const secrets = await this.load(threadId)
    if (!secrets) return event
    this.cache.set(threadId, secrets)
    return redactEvent(event, secrets.values)
  }

  invalidate(projectId: string): void {
    for (const [threadId, secrets] of this.cache) if (secrets.projectId === projectId) this.cache.delete(threadId)
  }

  forget(threadId: string): void {
    this.cache.delete(threadId)
  }
}
