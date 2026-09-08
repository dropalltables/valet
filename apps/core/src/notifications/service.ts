import { isIP } from 'node:net'
import { asc, eq } from 'drizzle-orm'
import webpush from 'web-push'
import { z } from 'zod'
import {
  MAX_WEBHOOKS,
  type NotificationEvent,
  type NotificationSettings,
  type NotificationTestResponse,
  type ThreadListItem,
  type ThreadStatus,
  type Webhook,
} from '@valet/shared'
import type { Config } from '../config.js'
import type { Cipher } from '../crypto.js'
import type { Db } from '../db/index.js'
import { pushSubscriptions, webhooks, type PushSubscriptionRow, type WebhookRow } from '../db/schema.js'
import { badRequest, notFound, statusOf } from '../errors.js'
import type { EventLog } from '../events/log.js'
import { newId } from '../ids.js'
import { errorMessage, logger } from '../logger.js'
import type { SettingsService } from '../settings.js'
import { buildNotification, buildPushPayload, buildWebhookRequest, notificationEvent, testNotification, type Notification } from './payload.js'

const log = logger('notifications')

/** One notification per thread and event within this window; status can flap. */
const DEDUP_MS = 30_000
const WEBHOOK_TIMEOUT_MS = 8_000
/** Seconds the push service keeps retrying; a stale "needs input" helps nobody. */
const PUSH_TTL_SECONDS = 60

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  // RFC 8291: an uncompressed P-256 point and a 16-byte auth secret. Anything else
  // can never be encrypted for, so it is rejected here instead of failing on every send.
  keys: z.object({
    p256dh: z.string().refine((v) => base64UrlBytes(v) === 65, 'p256dh must be a 65-byte key'),
    auth: z.string().refine((v) => base64UrlBytes(v) === 16, 'auth must be a 16-byte secret'),
  }),
})

/** DELETE a subscription, and POST a test to one: both name a stored endpoint. */
export const pushEndpointSchema = z.object({ endpoint: z.string().min(1) })

export const putWebhooksSchema = z.object({
  webhooks: z
    .array(
      z.object({
        id: z.string().optional(),
        kind: z.enum(['slack', 'discord', 'ntfy', 'generic']),
        url: z.string().url().optional(),
        secret: z.string().optional(),
        events: z.array(z.enum(['waiting', 'finished', 'error'])).min(1),
      }),
    )
    .max(MAX_WEBHOOKS),
})

export type NotificationServiceDeps = {
  db: Db
  cfg: Config
  cipher: Cipher
  events: EventLog
  settings: SettingsService
}

/**
 * Fans thread transitions out to browsers (Web Push) and webhooks.
 *
 * The source is the same thread row every client sees, so the previous status is
 * kept here rather than threaded through every call site that writes a status.
 * An empty map after a restart means the first transition core observes only
 * establishes the baseline, which is what keeps a restart from notifying about
 * work that finished while core was down.
 */
export class NotificationService {
  private readonly lastStatus = new Map<string, ThreadStatus>()
  private readonly lastSent = new Map<string, number>()

  private readonly db: Db
  private readonly cfg: Config
  private readonly cipher: Cipher
  private readonly events: EventLog
  private readonly settings: SettingsService

  constructor(deps: NotificationServiceDeps) {
    this.db = deps.db
    this.cfg = deps.cfg
    this.cipher = deps.cipher
    this.events = deps.events
    this.settings = deps.settings
  }

  /** Starts watching thread rows. Core watches for its whole life, so there is no stop. */
  watch(): void {
    this.events.subscribeGlobal((frame) => {
      if (frame.t === 'thread.deleted') {
        this.lastStatus.delete(frame.id)
        return
      }
      if (frame.t !== 'thread') return
      const thread = frame.thread
      const previous = this.lastStatus.get(thread.id)
      this.lastStatus.set(thread.id, thread.status)
      if (previous === undefined) return
      const event = notificationEvent(previous, thread.status)
      if (!event) return
      void this.fire(event, thread).catch((err: unknown) => log.warn('notify failed', { id: thread.id, err }))
    })
  }

  private async fire(event: NotificationEvent, thread: ThreadListItem): Promise<void> {
    const now = Date.now()
    for (const [key, at] of this.lastSent) if (now - at >= DEDUP_MS) this.lastSent.delete(key)
    const key = `${thread.id}:${event}`
    if (this.lastSent.has(key)) return
    this.lastSent.set(key, now)
    await this.deliver(
      buildNotification({ event, threadId: thread.id, title: thread.title, error: thread.error, baseUrl: this.cfg.VALET_BASE_URL }),
    )
  }

  private async deliver(n: Notification): Promise<void> {
    await Promise.all([this.push(n), this.fanoutWebhooks(n)])
  }

  // ---- state ------------------------------------------------------------------------

  async get(): Promise<NotificationSettings> {
    const [vapidPublicKey, subs, hooks] = await Promise.all([
      this.settings.vapidPublicKey(),
      this.db.select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions),
      this.listWebhooks(),
    ])
    return { vapidPublicKey, browsers: subs.length, webhooks: hooks.map((row) => this.toWebhook(row)) }
  }

  async subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
    assertPostableUrl(sub.endpoint)
    await this.db
      .insert(pushSubscriptions)
      .values({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } })
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))
  }

  private listWebhooks(): Promise<WebhookRow[]> {
    return this.db.select().from(webhooks).orderBy(asc(webhooks.position))
  }

  async putWebhooks(input: z.infer<typeof putWebhooksSchema>['webhooks']): Promise<NotificationSettings> {
    const existing = await this.db.select().from(webhooks)
    const byId = new Map(existing.map((r) => [r.id, r]))
    const seen = new Set<string>()
    const rows = input.map((w, position) => {
      const previous = w.id ? byId.get(w.id) : undefined
      if (w.id && !previous) throw notFound('webhook')
      if (previous && seen.has(previous.id)) throw badRequest(`duplicate webhook: ${previous.id}`)
      if (previous) seen.add(previous.id)
      // Only the masked URL was ever shown, so an unchanged one comes back omitted.
      const url = w.url ?? (previous ? this.cipher.decrypt(previous.urlEnc) : null)
      if (url === null) throw badRequest('url is required')
      assertPostableUrl(url)
      // A secret only signs the `generic` envelope; the other three authenticate by URL.
      const secretEnc = w.kind !== 'generic' ? null : w.secret ? this.cipher.encrypt(w.secret) : (previous?.secretEnc ?? null)
      // The list is rewritten wholesale, so the submitted order is the stored order.
      return { id: previous?.id ?? newId(), kind: w.kind, urlEnc: this.cipher.encrypt(url), secretEnc, events: w.events, position }
    })
    await this.db.transaction(async (tx) => {
      await tx.delete(webhooks)
      for (const row of rows) await tx.insert(webhooks).values(row)
    })
    return this.get()
  }

  // ---- delivery ---------------------------------------------------------------------

  /** Sends to every stored subscription; the failures are logged, never thrown. */
  private async push(n: Notification): Promise<void> {
    const rows = await this.db.select().from(pushSubscriptions)
    if (rows.length === 0) return
    const keys = await this.settings.vapidKeys()
    const payload = buildPushPayload(n)
    await Promise.all(rows.map((row) => this.pushOne(row, payload, keys)))
  }

  private async pushOne(row: PushSubscriptionRow, payload: string, keys: { publicKey: string; privateKey: string }): Promise<string | null> {
    try {
      await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, {
        TTL: PUSH_TTL_SECONDS,
        vapidDetails: { subject: vapidSubject(this.cfg.VALET_BASE_URL), ...keys },
      })
      return null
    } catch (err) {
      const message = errorMessage(err)
      const status = statusOf(err)
      // 404/410: the push service dropped the subscription. 403: it was created for a
      // different VAPID key. Either way nothing will ever reach it again.
      if (status === 403 || status === 404 || status === 410) await this.unsubscribe(row.endpoint)
      else log.warn('push failed', { status, error: message })
      return message
    }
  }

  private async fanoutWebhooks(n: Notification): Promise<void> {
    const rows = await this.listWebhooks()
    await Promise.all(
      rows
        .filter((row) => row.events.includes(n.event))
        .map((row) => this.postWebhook(row, n).catch((err: unknown) => log.warn('webhook failed', { id: row.id, kind: row.kind, err }))),
    )
  }

  private async postWebhook(row: WebhookRow, n: Notification): Promise<void> {
    const req = buildWebhookRequest(row.kind, row.secretEnc ? this.cipher.decrypt(row.secretEnc) : null, n)
    const res = await fetch(this.cipher.decrypt(row.urlEnc), {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      // The URL was checked when it was stored; a redirect would send the request
      // somewhere that was never checked, so a 3xx counts as a failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
    // Only the status: the response body would reflect whatever core can reach back into the UI.
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  // ---- tests ------------------------------------------------------------------------

  /** Pushes to the one browser that asked, which is how the UI presents Test. */
  async testPush(endpoint: string): Promise<NotificationTestResponse> {
    const [row] = await this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))
    if (!row) throw notFound('subscription')
    const keys = await this.settings.vapidKeys()
    const error = await this.pushOne(row, buildPushPayload(testNotification(this.cfg.VALET_BASE_URL)), keys)
    return error === null ? { ok: true, error: null } : { ok: false, error }
  }

  private toWebhook(row: WebhookRow): Webhook {
    return { id: row.id, kind: row.kind, url: maskUrl(this.cipher.decrypt(row.urlEnc)), hasSecret: row.secretEnc !== null, events: row.events }
  }

  async testWebhook(id: string): Promise<NotificationTestResponse> {
    const [row] = await this.db.select().from(webhooks).where(eq(webhooks.id, id))
    if (!row) throw notFound('webhook')
    try {
      await this.postWebhook(row, testNotification(this.cfg.VALET_BASE_URL))
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }
}

/** Enough of a URL to tell two webhooks apart in the list, and no more. */
function maskUrl(raw: string): string {
  const { host } = new URL(raw)
  return `${host}/…${raw.slice(-4)}`
}

function base64UrlBytes(value: string): number {
  return Buffer.from(value, 'base64url').length
}

/**
 * Core POSTs to operator-supplied URLs, so the addresses that only exist from inside
 * the server are refused: its own loopback, the unspecified address, and the
 * link-local range cloud metadata services live on.
 */
export function assertPostableUrl(raw: string): void {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest(`unsupported URL scheme: ${url.protocol}`)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isInternalHost(host)) throw badRequest(`unroutable host: ${url.hostname}`)
}

function isInternalHost(host: string): boolean {
  switch (isIP(host)) {
    case 4: {
      const [a, b] = host.split('.').map(Number)
      return a === 0 || a === 127 || (a === 169 && b === 254)
    }
    case 6:
      // ::, ::1, and fe80::/10.
      return host === '::' || host === '::1' || /^fe[89ab]/.test(host)
    default:
      return host === 'localhost' || host.endsWith('.localhost')
  }
}

/** RFC 8292 requires an `https:` or `mailto:` contact; a local base URL is neither. */
function vapidSubject(baseUrl: string): string {
  return baseUrl.startsWith('https://') ? baseUrl : 'mailto:valet@localhost'
}
