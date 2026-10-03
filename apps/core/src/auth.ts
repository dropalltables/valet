import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { getConnInfo } from '@hono/node-server/conninfo'
import { and, eq, gt, lt, sql } from 'drizzle-orm'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { LoginRequest, SessionResponse } from '@valet/shared'
import type { Config } from './config.js'
import { timingSafeEqualStrings, type Cipher } from './crypto.js'
import type { Db } from './db/index.js'
import { authSessions, authState } from './db/schema.js'
import { jsonBody } from './routes/validate.js'

export const SESSION_COOKIE = 'valet_session'
const SESSION_MAX_AGE_S = 30 * 24 * 3600
const LOGIN_BODY_MAX_BYTES = 4096
const STATE_ROW_ID = 'default'
const loginSchema = z.object({ password: z.string().max(1024) }) satisfies z.ZodType<LoginRequest>

type Attempts = { failures: number; resetAt: number }

export class Auth {
  readonly enabled: boolean
  private readonly password: string | null
  private readonly secure: boolean
  private readonly allowedOrigin: string
  private readonly attempts = new Map<string, Attempts>()
  private readonly logoutHooks: Array<() => Promise<void>> = []

  constructor(
    cfg: Config,
    private readonly cipher: Cipher,
    private readonly db: Db,
  ) {
    this.password = cfg.VALET_PASSWORD ?? null
    this.enabled = this.password !== null
    this.secure = cfg.VALET_BASE_URL.startsWith('https://')
    this.allowedOrigin = new URL(cfg.VALET_BASE_URL).origin
  }

  async load(): Promise<void> {
    const fingerprint = this.password === null ? null : this.cipher.hmacHex(`valet-password-v1:${this.password}`)
    const [row] = await this.db.select().from(authState).where(eq(authState.id, STATE_ROW_ID))
    if (row?.passwordFingerprint !== fingerprint) {
      await this.db.transaction(async (tx) => {
        await tx.delete(authSessions)
        await tx.update(authState).set({ serviceOwnerGeneration: sql`${authState.serviceOwnerGeneration} + 1` }).where(eq(authState.id, STATE_ROW_ID))
        await tx
          .insert(authState)
          .values({ id: STATE_ROW_ID, passwordFingerprint: fingerprint })
          .onConflictDoUpdate({ target: authState.id, set: { passwordFingerprint: fingerprint } })
      })
    }
    await this.db.delete(authSessions).where(lt(authSessions.expiresAt, new Date()))
  }

  private hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex')
  }

  private async validCookie(value: string | undefined): Promise<boolean> {
    if (!value) return false
    const [row] = await this.db
      .select({ tokenHash: authSessions.tokenHash })
      .from(authSessions)
      .where(and(eq(authSessions.tokenHash, this.hash(value)), gt(authSessions.expiresAt, new Date())))
      .limit(1)
    return row !== undefined
  }

  async authorizedCookieHeader(header: string | undefined): Promise<boolean> {
    if (!this.enabled) return true
    return this.validCookie(parseCookie(header)[SESSION_COOKIE])
  }

  authorizedUpgrade(req: IncomingMessage): Promise<boolean> {
    return this.authorizedCookieHeader(req.headers.cookie)
  }

  originAllowed(origin: string | undefined, fetchSite: string | undefined): boolean {
    if (origin) return origin === this.allowedOrigin
    return fetchSite === undefined || fetchSite === 'none' || fetchSite === 'same-origin'
  }

  /** Runs on every logout. Cookies on other hosts (services) cannot be deleted from here, only revoked. */
  onLogout(hook: () => Promise<void>): void {
    this.logoutHooks.push(hook)
  }

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      if (!this.enabled) return next()
      const path = c.req.path
      if (path === '/api/health' || path.startsWith('/api/auth/') || path.startsWith('/api/share/')) return next()
      if (!(await this.validCookie(getCookie(c, SESSION_COOKIE)))) return c.json({ error: 'unauthorized' }, 401)
      if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !this.originAllowed(c.req.header('origin'), c.req.header('sec-fetch-site'))) {
        return c.json({ error: 'forbidden origin' }, 403)
      }
      return next()
    }
  }

  private peer(c: Context): string {
    return c.env ? (getConnInfo(c).remote.address ?? 'unknown') : 'unknown'
  }

  private throttled(key: string, limit: number, now: number): boolean {
    const value = this.attempts.get(key)
    if (!value || value.resetAt <= now) return false
    return value.failures >= limit
  }

  private failed(key: string, now: number): void {
    if (this.attempts.size > 100) {
      for (const [peer, attempt] of this.attempts) if (attempt.resetAt <= now) this.attempts.delete(peer)
    }
    const value = this.attempts.get(key)
    this.attempts.set(key, !value || value.resetAt <= now ? { failures: 1, resetAt: now + 15 * 60_000 } : { ...value, failures: value.failures + 1 })
  }

  routes(): Hono {
    const app = new Hono()
    app.use('/api/auth/login', bodyLimit({ maxSize: LOGIN_BODY_MAX_BYTES }))
    app.post('/api/auth/login', jsonBody(loginSchema), async (c) => {
      if (!this.originAllowed(c.req.header('origin'), c.req.header('sec-fetch-site'))) return c.json({ error: 'forbidden origin' }, 403)
      const now = Date.now()
      const peer = `peer:${this.peer(c)}`
      if (this.throttled(peer, 8, now) || this.throttled('global', 50, now)) return c.json({ error: 'too many attempts' }, 429)
      const { password } = c.req.valid('json')
      if (!this.enabled) return c.json({ error: 'authentication is disabled' }, 400)
      if (!timingSafeEqualStrings(password, this.password ?? '')) {
        this.failed(peer, now)
        this.failed('global', now)
        return c.json({ error: 'wrong password' }, 401)
      }
      const token = crypto.randomBytes(32).toString('base64url')
      await this.db.insert(authSessions).values({ tokenHash: this.hash(token), expiresAt: new Date(now + SESSION_MAX_AGE_S * 1000) })
      this.attempts.delete(peer)
      setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: this.secure, path: '/', maxAge: SESSION_MAX_AGE_S })
      const body: SessionResponse = { authenticated: true, required: true }
      return c.json(body)
    })
    app.get('/api/auth/session', async (c) => {
      const body: SessionResponse = { authenticated: !this.enabled || (await this.validCookie(getCookie(c, SESSION_COOKIE))), required: this.enabled }
      return c.json(body)
    })
    app.post('/api/auth/logout', async (c) => {
      if (!this.originAllowed(c.req.header('origin'), c.req.header('sec-fetch-site'))) return c.json({ error: 'forbidden origin' }, 403)
      const token = getCookie(c, SESSION_COOKIE)
      if (this.enabled && !(await this.validCookie(token))) return c.json({ error: 'unauthorized' }, 401)
      if (token) await this.db.delete(authSessions).where(eq(authSessions.tokenHash, this.hash(token)))
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
      out[name] = raw
    }
  }
  return out
}
