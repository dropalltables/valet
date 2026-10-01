import type { IncomingMessage } from 'node:http'
import { Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { LoginRequest, SessionResponse } from '@valet/shared'
import type { Config } from './config.js'
import { timingSafeEqualStrings, type Cipher } from './crypto.js'
import { jsonBody } from './routes/validate.js'

export const SESSION_COOKIE = 'valet_session'
const SESSION_MAX_AGE_S = 30 * 24 * 3600

const loginSchema = z.object({ password: z.string() }) satisfies z.ZodType<LoginRequest>

/** Single shared password; the cookie value is a fixed HMAC so login is stateless. */
export class Auth {
  readonly enabled: boolean
  private readonly sessionValue: string
  private readonly password: string | null
  private readonly secure: boolean
  private readonly logoutHooks: Array<() => Promise<void>> = []

  constructor(cfg: Config, cipher: Cipher) {
    this.password = cfg.VALET_PASSWORD ?? null
    this.enabled = this.password !== null
    this.sessionValue = cipher.hmacHex('valet-session-v1')
    this.secure = cfg.VALET_BASE_URL.startsWith('https://')
  }

  private validCookie(value: string | undefined): boolean {
    return value !== undefined && timingSafeEqualStrings(value, this.sessionValue)
  }

  authorizedCookieHeader(header: string | undefined): boolean {
    if (!this.enabled) return true
    return this.validCookie(parseCookie(header)[SESSION_COOKIE])
  }

  authorizedUpgrade(req: IncomingMessage): boolean {
    return this.authorizedCookieHeader(req.headers.cookie)
  }

  /** Runs on every logout. Cookies on other hosts (services) cannot be deleted from here, only revoked. */
  onLogout(hook: () => Promise<void>): void {
    this.logoutHooks.push(hook)
  }

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      if (!this.enabled) return next()
      const path = c.req.path
      // `/api/share/` carries its own credential in the path: the unlisted link token.
      if (path === '/api/health' || path.startsWith('/api/auth/') || path.startsWith('/api/share/')) return next()
      if (!this.validCookie(getCookie(c, SESSION_COOKIE))) return c.json({ error: 'unauthorized' }, 401)
      return next()
    }
  }

  routes(): Hono {
    const app = new Hono()
    app.post('/api/auth/login', jsonBody(loginSchema), (c) => {
      const { password } = c.req.valid('json')
      if (!this.enabled) return c.json({ error: 'authentication is disabled' }, 400)
      if (!timingSafeEqualStrings(password, this.password ?? '')) return c.json({ error: 'wrong password' }, 401)
      setCookie(c, SESSION_COOKIE, this.sessionValue, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: this.secure,
        path: '/',
        maxAge: SESSION_MAX_AGE_S,
      })
      const body: SessionResponse = { authenticated: true, required: true }
      return c.json(body)
    })
    app.get('/api/auth/session', (c) => {
      const body: SessionResponse = {
        authenticated: !this.enabled || this.validCookie(getCookie(c, SESSION_COOKIE)),
        required: this.enabled,
      }
      return c.json(body)
    })
    app.post('/api/auth/logout', async (c) => {
      for (const hook of this.logoutHooks) await hook()
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.body(null, 204)
    })
    return app
  }
}

export function parseCookie(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const name = part.slice(0, idx).trim()
    if (!name) continue
    const raw = part.slice(idx + 1).trim()
    try {
      out[name] = decodeURIComponent(raw)
    } catch {
      // Malformed percent-encoding from a client; the raw value can only ever fail to match.
      out[name] = raw
    }
  }
  return out
}
