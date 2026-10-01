import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { SERVICE_ENV, SUPERVISOR_TOKEN_ENV } from '@valet/shared'

/**
 * Container env that spawned processes inherit. Everything else the supervisor
 * was started with (notably the token) stays with the supervisor.
 */
const BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'AGENT_BROWSER_EXECUTABLE_PATH',
  'TERM',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  SERVICE_ENV.threadId,
  SERVICE_ENV.urlTemplate,
] as const

export function childEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (key === SUPERVISOR_TOKEN_ENV) continue
    env[key] = value
  }
  return env
}

export function requireToken(): string {
  const token = process.env[SUPERVISOR_TOKEN_ENV]
  if (!token) throw new Error(`${SUPERVISOR_TOKEN_ENV} is not set`)
  return token
}

export function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
