import type { PushSubscriptionRequest } from '@valet/shared'

/**
 * Web Push in this browser. `denied` cannot be undone from script: only the user
 * can flip it back in site settings.
 */
export type PushState = 'unsupported' | 'denied' | 'off' | 'on'

/** The endpoint is set exactly when the state is `on`; it names this browser to core. */
export type PushStatus = { state: PushState; endpoint: string | null }

/** A fresh subscription, plus the endpoint it replaced so core can forget that row. */
export type EnabledPush = { subscription: PushSubscriptionRequest; replaced: string | null }

const SCOPE = '/'

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

async function subscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(SCOPE)
  return (await registration?.pushManager.getSubscription()) ?? null
}

export async function pushStatus(): Promise<PushStatus> {
  if (!supported()) return { state: 'unsupported', endpoint: null }
  if (Notification.permission === 'denied') return { state: 'denied', endpoint: null }
  const sub = await subscription()
  return sub ? { state: 'on', endpoint: sub.endpoint } : { state: 'off', endpoint: null }
}

/** Must run inside a click handler: browsers only prompt for permission on a gesture. */
export async function enablePush(vapidPublicKey: string): Promise<EnabledPush> {
  if (!supported()) throw new Error('This browser does not support push notifications')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked in this browser')
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: SCOPE })
  await navigator.serviceWorker.ready
  const key = decodeVapidKey(vapidPublicKey)
  let sub = await registration.pushManager.getSubscription()
  // A subscription made for an older VAPID pair is rejected by the push service with
  // 403 forever, so it is replaced rather than handed back to core.
  let replaced: string | null = null
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    replaced = sub.endpoint
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  const keys = sub.toJSON().keys
  if (!keys?.p256dh || !keys.auth) throw new Error('Subscription is missing its keys')
  return { subscription: { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, replaced }
}

/** Returns the endpoint core should forget, or null when this browser had none. */
export async function disablePush(): Promise<string | null> {
  const sub = await subscription()
  if (!sub) return null
  await sub.unsubscribe()
  return sub.endpoint
}

function sameKey(subscribed: ArrayBuffer | null, current: Uint8Array): boolean {
  if (!subscribed) return false
  const bytes = new Uint8Array(subscribed)
  return bytes.length === current.length && bytes.every((b, i) => b === current[i])
}

/** VAPID keys travel as base64url; `PushManager` wants the raw bytes. */
function decodeVapidKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64Url.length % 4)) % 4)
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}
