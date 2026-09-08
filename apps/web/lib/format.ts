import type { ThreadStatus } from '@valet/shared'

export const STATUS_LABELS: Record<ThreadStatus, string> = {
  provisioning: 'Provisioning',
  running: 'Running',
  waiting: 'Waiting',
  idle: 'Idle',
  paused: 'Paused',
  error: 'Error',
  archived: 'Archived',
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' })

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now
  const abs = Math.abs(diff)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (abs < minute) return 'now'
  if (abs < hour) return RELATIVE.format(Math.round(diff / minute), 'minute')
  if (abs < day) return RELATIVE.format(Math.round(diff / hour), 'hour')
  if (abs < 30 * day) return RELATIVE.format(Math.round(diff / day), 'day')
  return new Date(iso).toLocaleDateString()
}

export function duration(startIso: string, endIso: string | null): string | null {
  if (!startIso) return null
  const end = endIso ? new Date(endIso).getTime() : Date.now()
  const ms = end - new Date(startIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function usd(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return `$${value.toFixed(value < 1 ? 3 : 2)}`
}

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// CSI sequences (colors, cursor moves) and OSC sequences (titles, hyperlinks).
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

export function repoSlug(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/github\.com\//, '')
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}
