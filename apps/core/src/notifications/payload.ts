import crypto from 'node:crypto'
import type { NotificationEvent, ThreadStatus, WebhookKind } from '@valet/shared'

/** A notification resolved to the text and link every channel renders. */
export type Notification = {
  event: NotificationEvent
  threadId: string
  /** The thread title. */
  title: string
  body: string
  /** Absolute URL of the thread. */
  url: string
  at: string
}

/** A POST every channel makes the same way: same URL, headers, and raw body. */
export type WebhookRequest = { headers: Record<string, string>; body: string }

/**
 * Which notification a status change raises, or null for the transitions that are
 * not worth one (provisioning, pause, archive, wake).
 */
export function notificationEvent(from: ThreadStatus, to: ThreadStatus): NotificationEvent | null {
  if (from === to) return null
  if (to === 'waiting') return 'waiting'
  if (to === 'error') return 'error'
  // Idle is reached both after a turn and after a wake; only the former finished one.
  if (to === 'idle' && (from === 'running' || from === 'waiting')) return 'finished'
  return null
}

/**
 * Thread titles and thread errors are both unbounded (an error can be a whole
 * stderr), and every channel has its own limit: 4 KB for the push protocol, and
 * shorter ones for Slack, Discord, and ntfy. One cap here keeps them all the same.
 */
const MAX_TITLE = 120
const MAX_ERROR = 200

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

function bodyFor(event: NotificationEvent, error: string | null): string {
  switch (event) {
    case 'waiting':
      return 'Needs your input'
    case 'finished':
      return 'Finished'
    case 'error':
      return error ? `Error: ${truncate(error, MAX_ERROR)}` : 'Error'
  }
}

export function buildNotification(input: {
  event: NotificationEvent
  threadId: string
  title: string
  error: string | null
  baseUrl: string
  at?: string
}): Notification {
  return {
    event: input.event,
    threadId: input.threadId,
    title: truncate(input.title, MAX_TITLE),
    body: bodyFor(input.event, input.error),
    url: new URL(`/threads/${input.threadId}`, input.baseUrl).toString(),
    at: input.at ?? new Date().toISOString(),
  }
}

/** What the Test buttons send, on every channel. */
export function testNotification(baseUrl: string, at?: string): Notification {
  return {
    event: 'finished',
    threadId: 'test',
    title: 'Valet',
    body: 'Test notification',
    url: new URL('/', baseUrl).toString(),
    at: at ?? new Date().toISOString(),
  }
}

/** Read by `public/sw.js`. `buildNotification` caps the text, so this stays well under 4 KB. */
export function buildPushPayload(n: Notification): string {
  return JSON.stringify({ title: n.title, body: n.body, url: n.url, threadId: n.threadId })
}

export function signPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

/** Slack mrkdwn reserves these three characters. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Header values must be latin-1 without control characters; anything else goes as
 * RFC 2047 encoded-words, which ntfy decodes.
 */
function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ')
  if (/^[\x20-\x7e]*$/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

export function buildWebhookRequest(kind: WebhookKind, secret: string | null, n: Notification): WebhookRequest {
  const json = (value: unknown): WebhookRequest => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  switch (kind) {
    case 'slack':
      return json({
        text: `${n.title} — ${n.body}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlack(n.title)}*\n${escapeSlack(n.body)}\n<${n.url}>` } },
        ],
      })
    case 'discord':
      return json({ embeds: [{ title: n.title, description: n.body, url: n.url }] })
    case 'ntfy':
      return {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          Title: encodeHeader(n.title),
          Priority: n.event === 'error' ? 'high' : 'default',
          Click: n.url,
        },
        body: n.body,
      }
    case 'generic': {
      const req = json({ event: n.event, threadId: n.threadId, title: n.title, body: n.body, url: n.url, at: n.at })
      if (secret) req.headers['x-valet-signature'] = `sha256=${signPayload(req.body, secret)}`
      return req
    }
  }
}
