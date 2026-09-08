import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { Readable, type Duplex } from 'node:stream'
import type { HttpBindings } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono, type Context } from 'hono'
import { setCookie } from 'hono/cookie'
import {
  PORTAL_APP_AUTHORIZATION_HEADER,
  PORTAL_AUTH_PATH,
  PORTAL_ERROR_HEADER,
  PORTAL_REVIEW_HEADER,
  PORTAL_REVIEW_PATH,
  PORTAL_REVIEW_SCRIPT_PATH,
  PORTAL_WAKE_PATH,
  type PortalAuthUrlResponse,
  type ShareHours,
  type SharePortalResponse,
} from '@valet/shared'
import { z } from 'zod'
import type { Auth } from '../auth.js'
import type { Config } from '../config.js'
import type { SupervisorClient } from '../docker/supervisor-client.js'
import { HttpError } from '../errors.js'
import { errorMessage, logger } from '../logger.js'
import type { ThreadService } from '../threads/service.js'
import { OWNER_TOKEN_TTL_MS, PORTAL_COOKIE, type PortalAuth, type PortalGrant } from './auth.js'
import { deniedPage, errorPage, notFoundPage, pausedPage, unavailablePage } from './pages.js'
import {
  MAX_HTML_BYTES,
  REVIEW_WIDGET_JS,
  allowInjectedScript,
  decodeHtml,
  injectWidget,
  injectionPoint,
  isInjectableHtml,
  reviewMessage,
  widgetTag,
} from './review.js'
import type { PortalUrls } from './urls.js'

const log = logger('portals')

/** Set by the web app's Host rewrite: the hostname the browser used. */
export const PORTAL_HOST_HEADER = 'x-valet-portal-host'
const THREAD_ID_RE = /^[a-z0-9]+$/
/** Time allowed to reach the supervisor; the app's own connect timeout lives in the supervisor. */
const CONNECT_TIMEOUT_MS = 30_000

/** `Location: http://localhost:3000/x` from an app becomes the portal serving that port. */
const LOOPBACK_ORIGIN_RE = /^(https?):\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d+))?(?=[/?#]|$)/i
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
/** Statuses whose response carries no body; `new Response` throws when given one. */
const BODYLESS_STATUS = new Set([101, 204, 205, 304])
const reviewSchema = z.object({ selector: z.string().max(2000), path: z.string().max(2000), excerpt: z.string().max(200), note: z.string().trim().min(1).max(4000) })
/** Bytes held while looking for the injection point before a document is passed through. */
const SCAN_BYTES = 64 * 1024
/** Connection-level failures: nothing answered at the supervisor's address. */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'])

type Ctx = Context<{ Bindings: HttpBindings }>

export type GatewayDeps = { cfg: Config; urls: PortalUrls; portalAuth: PortalAuth; auth: Auth; threads: ThreadService }

type Route = {
  threadId: string
  port: number
  /** Browser-facing host, e.g. `t-abc-p3000.localhost:3000`. */
  host: string
  origin: string
  /** Path and query inside the portal, starting with `/`. */
  rest: string
}

function parseRoute(threadId: string, portRaw: string, pathAndQuery: string, host: string | undefined, urls: PortalUrls): Route | null {
  const port = Number(portRaw)
  if (!THREAD_ID_RE.test(threadId) || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const prefix = `/portal/${threadId}/${port}`
  if (!pathAndQuery.startsWith(prefix)) return null
  const rest = pathAndQuery.slice(prefix.length) || '/'
  const h = host ?? urls.host(threadId, port)
  return { threadId, port, host: h, origin: `${urls.scheme}://${h}`, rest: rest.startsWith('/') ? rest : `/${rest}` }
}

function withoutCookie(header: string | null, name: string): string | null {
  if (!header) return null
  const kept = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${name}=`))
  return kept.length > 0 ? kept.join('; ') : null
}

/**
 * Headers the app receives. The browser's Authorization is parked so the
 * supervisor's bearer can take the slot; the supervisor swaps them back. Our own
 * cookie stays out of the app's view.
 */
function forwardHeaders(
  incoming: Headers,
  opts: { route: Route; grant: PortalGrant; scheme: string; clientIp: string | null; supervisor: Record<string, string> },
): Headers {
  const h = new Headers(incoming)
  // `Expect: 100-continue` was answered at this hop by Node's server; undici and the app must not see it again.
  for (const name of ['host', 'expect', PORTAL_HOST_HEADER, ...HOP_BY_HOP]) h.delete(name)
  const browserAuth = h.get('authorization')
  h.delete('authorization')
  if (browserAuth) h.set(PORTAL_APP_AUTHORIZATION_HEADER, browserAuth)
  else h.delete(PORTAL_APP_AUTHORIZATION_HEADER)
  for (const [k, v] of Object.entries(opts.supervisor)) h.set(k, v)
  const cookie = withoutCookie(h.get('cookie'), PORTAL_COOKIE)
  if (cookie) h.set('cookie', cookie)
  else h.delete('cookie')
  h.set('x-forwarded-host', opts.route.host)
  h.set('x-forwarded-proto', opts.scheme)
  const forwardedFor = h.get('x-forwarded-for') ?? opts.clientIp
  if (forwardedFor) h.set('x-forwarded-for', forwardedFor)
  h.set('x-valet-user', opts.grant)
  return h
}

/** Makes the app embeddable in the Portals tab and keeps loopback redirects inside the portal. */
function rewriteResponseHeaders(headers: Headers, route: Route, urls: PortalUrls): void {
  headers.delete('x-frame-options')
  for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
    const csp = headers.get(name)
    if (!csp || !/frame-ancestors/i.test(csp)) continue
    const kept = csp
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d))
    if (kept.length > 0) headers.set(name, kept.join('; '))
    else headers.delete(name)
  }
  const location = headers.get('location')
  if (location) {
    const m = LOOPBACK_ORIGIN_RE.exec(location)
    if (m) {
      const port = m[2] ? Number(m[2]) : m[1]?.toLowerCase() === 'https' ? 443 : 80
      const origin = port === route.port ? route.origin : urls.origin(route.threadId, port)
      headers.set('location', origin + location.slice(m[0].length))
    }
  }
  headers.set('x-valet-portal', '1')
}

function incomingToHeaders(raw: IncomingHttpHeaders): Headers {
  const h = new Headers()
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') h.set(k, v)
    else if (Array.isArray(v)) for (const item of v) h.append(k, item)
  }
  return h
}

/** Response headers from the supervisor, minus this hop's; repeated `Set-Cookie` values survive. */
function responseHeaders(res: IncomingMessage): Headers {
  const h = new Headers()
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    const name = (res.rawHeaders[i] ?? '').toLowerCase()
    if (HOP_BY_HOP.includes(name)) continue
    h.append(name, res.rawHeaders[i + 1] ?? '')
  }
  return h
}

function isUnreachable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return (code !== undefined && UNREACHABLE_CODES.has(code)) || (err instanceof Error && err.message === 'connect timeout')
}

/** Destroys `req` when the TCP connect takes too long; pooled sockets and later idle time are untouched. */
function connectTimeout(req: ClientRequest): void {
  req.on('socket', (socket) => {
    if (!socket.connecting) return
    const timer = setTimeout(() => req.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS)
    const clear = (): void => clearTimeout(timer)
    socket.once('connect', clear)
    socket.once('close', clear)
  })
}

type Read = { kind: 'whole'; body: Buffer } | { kind: 'partial'; head: Buffer[] }

/** The whole body, or the chunks read so far once it grows past `cap`, leaving the rest unread. */
function readCapped(res: IncomingMessage, cap: number): Promise<Read> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const stop = (): void => {
      res.off('data', onData)
      res.off('end', onEnd)
      res.off('close', onClose)
      res.off('error', onError)
    }
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
      size += chunk.byteLength
      if (size <= cap) return
      stop()
      res.pause()
      resolve({ kind: 'partial', head: chunks })
    }
    const onEnd = (): void => {
      stop()
      resolve({ kind: 'whole', body: Buffer.concat(chunks) })
    }
    // The browser going away destroys the request, and with it this response mid-body.
    const onClose = (): void => {
      stop()
      reject(new Error('the sandbox closed the response'))
    }
    const onError = (err: Error): void => {
      stop()
      reject(err)
    }
    res.on('data', onData)
    res.on('end', onEnd)
    res.on('close', onClose)
    res.on('error', onError)
  })
}

/** What was read before the cap, then the rest of the response as it arrives. */
async function* resume(head: Buffer[], rest: IncomingMessage): AsyncGenerator<Buffer> {
  for (const chunk of head) yield chunk
  for await (const chunk of rest) yield chunk as Buffer
}

/**
 * The response with the widget's script tag inserted after its `<head>` open tag, as
 * the bytes arrive: a page that streams its shell first still reaches the browser
 * first. Only the first `SCAN_BYTES` are held, and a document that has neither a
 * `<head>` nor a `<body>` by then is passed through untouched.
 */
async function* withWidget(res: IncomingMessage, tag: Buffer): AsyncGenerator<Buffer> {
  let pending: Buffer | null = null
  let placed = false
  for await (const chunk of res as AsyncIterable<Buffer>) {
    if (placed) {
      yield chunk
      continue
    }
    const prefix: Buffer = pending ? Buffer.concat([pending, chunk]) : chunk
    const at = injectionPoint(prefix)
    if (at === null && prefix.byteLength < SCAN_BYTES) {
      pending = prefix
      continue
    }
    placed = true
    pending = null
    if (at === null) yield prefix
    else {
      yield prefix.subarray(0, at)
      yield tag
      yield prefix.subarray(at)
    }
  }
  // The whole document was shorter than one open tag's worth of scanning.
  if (pending) {
    yield pending
    yield tag
  }
}

/**
 * The response body with the review widget's script tag in it, for an owner's HTML
 * documents only; every other response goes straight through. `Content-Length` is
 * dropped rather than recomputed, so the tag can be inserted without holding the body.
 * An app that compressed anyway, despite the `accept-encoding: identity` this request
 * asked for, has to be decoded whole: that body is passed through exactly as it
 * arrived when it cannot be decoded, and goes back to streaming when it outgrows the
 * cap rather than filling core's heap with an app's endless page.
 */
async function injectReview(res: IncomingMessage, headers: Headers): Promise<Buffer | ReadableStream> {
  const encoding = headers.get('content-encoding')?.trim().toLowerCase() ?? 'identity'
  if (encoding === 'identity' || encoding === '') {
    const tag = Buffer.from(widgetTag(allowInjectedScript(headers)), 'utf8')
    headers.delete('content-length')
    return Readable.toWeb(Readable.from(withWidget(res, tag))) as ReadableStream
  }
  const declared = Number(headers.get('content-length'))
  if (Number.isInteger(declared) && declared > MAX_HTML_BYTES) return Readable.toWeb(res) as ReadableStream
  const read = await readCapped(res, MAX_HTML_BYTES)
  if (read.kind === 'partial') return Readable.toWeb(Readable.from(resume(read.head, res))) as ReadableStream
  const html = decodeHtml(read.body, encoding)
  if (html === null) return read.body
  const out = Buffer.from(injectWidget(html, allowInjectedScript(headers)), 'utf8')
  headers.delete('content-encoding')
  headers.set('content-length', String(out.byteLength))
  return out
}

/** Sends the request and resolves on the first response; rejects when nothing answers. */
function sendUpstream(req: ClientRequest, body: Readable | null): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    req.once('response', resolve)
    // Kept after the response too: a reset while the body is still streaming up must not go unhandled.
    req.on('error', reject)
    if (body) {
      body.once('error', (err) => req.destroy(err))
      body.pipe(req)
    } else req.end()
  })
}

/**
 * Portal traffic: `/portal/:threadId/:port/*` proxied into the sandbox, the cookie
 * bootstrap on the portal host, and `/api/portal-auth` on the main host.
 */
export class PortalGateway {
  constructor(private readonly deps: GatewayDeps) {}

  routes(): Hono<{ Bindings: HttpBindings }> {
    const app = new Hono<{ Bindings: HttpBindings }>()
    app.get('/api/portal-auth', (c) => this.startAuth(c))
    app.all('/portal/:threadId/:port', (c) => this.handle(c))
    app.all('/portal/:threadId/:port/*', (c) => this.handle(c))
    return app
  }

  /**
   * Main host: the browser has `valet_session` here. Turns it into a one-time token
   * for exactly the portal in `return`, so the portal host can set its own cookie.
   */
  private startAuth(c: Context): Response {
    const ret = c.req.query('return') ?? ''
    let target: URL
    try {
      target = new URL(ret)
    } catch {
      return c.html(deniedPage('Invalid return URL'), 400)
    }
    const portal = this.deps.urls.parse(target.host)
    if (!portal || target.protocol !== `${this.deps.urls.scheme}:`) return c.html(deniedPage('Invalid return URL'), 400)
    if (!this.deps.auth.authorizedCookieHeader(c.req.header('cookie'))) {
      const login = new URL('/login', this.deps.cfg.VALET_BASE_URL)
      login.searchParams.set('next', `/api/portal-auth?return=${encodeURIComponent(ret)}`)
      return c.redirect(login.toString(), 302)
    }
    const token = this.deps.portalAuth.mint({
      v: 1,
      t: portal.threadId,
      p: portal.port,
      s: 'owner',
      g: 0,
      exp: Date.now() + OWNER_TOKEN_TTL_MS,
      ret: target.pathname + target.search,
    })
    return c.redirect(`${target.origin}${PORTAL_AUTH_PATH}?token=${token}`, 302)
  }

  private async handle(c: Ctx): Promise<Response> {
    const url = new URL(c.req.url)
    const route = parseRoute(c.req.param('threadId') ?? '', c.req.param('port') ?? '', url.pathname + url.search, c.req.header(PORTAL_HOST_HEADER), this.deps.urls)
    if (!route) return c.html(notFoundPage(), 404)
    try {
      return await this.serve(c, route, url)
    } catch (err) {
      log.warn('portal request failed', { id: route.threadId, port: route.port, message: errorMessage(err) })
      return c.html(errorPage(errorMessage(err)), 500)
    }
  }

  private async serve(c: Ctx, route: Route, url: URL): Promise<Response> {
    const target = await this.deps.threads.portalTarget(route.threadId)
    if (target.kind === 'missing') return c.html(notFoundPage(), 404)
    const generation = target.row.portalShares?.[String(route.port)]?.generation ?? 0
    const path = route.rest.split('?', 1)[0] ?? '/'

    if (path === PORTAL_AUTH_PATH) {
      const token = this.deps.portalAuth.read(url.searchParams.get('token') ?? '')
      if (!token || token.t !== route.threadId || token.p !== route.port) return c.html(deniedPage('This link is invalid or has expired'), 403)
      if (token.s === 'share' && token.g !== generation) return c.html(deniedPage('This link has been revoked'), 403)
      if (this.deps.portalAuth.enabled) {
        const cookie = this.deps.portalAuth.cookie(route.host, token)
        // Cross-site portal hosts (`*.localhost`) are only reachable from the Portals
        // tab's iframe with a SameSite=None cookie, which must be Secure and, so that
        // third-party cookie blocking leaves it alone, Partitioned. Browsers treat
        // `*.localhost` as a secure context even over http.
        const crossSite = !this.deps.urls.sameSite
        setCookie(c, PORTAL_COOKIE, cookie.value, {
          httpOnly: true,
          sameSite: crossSite ? 'None' : 'Lax',
          secure: crossSite || this.deps.urls.secure,
          partitioned: crossSite,
          path: '/',
          maxAge: cookie.maxAge,
        })
      }
      const ret = token.ret.startsWith('/') && !token.ret.startsWith('//') ? token.ret : '/'
      return c.redirect(ret, 302)
    }

    const grant = this.deps.portalAuth.grant(c.req.header('cookie'), route.host, generation)
    if (!grant) {
      const login = new URL('/api/portal-auth', this.deps.cfg.VALET_BASE_URL)
      login.searchParams.set('return', route.origin + route.rest)
      return c.redirect(login.toString(), 302)
    }

    if (path === PORTAL_WAKE_PATH) {
      if (c.req.method !== 'POST') return c.html(notFoundPage(), 404)
      if (grant !== 'owner') return c.html(deniedPage('Only the owner can wake this sandbox'), 403)
      await this.deps.threads.wake(route.threadId)
      return c.redirect('/', 303)
    }

    if (path === PORTAL_REVIEW_SCRIPT_PATH) {
      if (c.req.method !== 'GET' || grant !== 'owner') return c.html(notFoundPage(), 404)
      return new Response(REVIEW_WIDGET_JS, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' } })
    }
    if (path === PORTAL_REVIEW_PATH) {
      if (c.req.method !== 'POST') return c.html(notFoundPage(), 404)
      if (grant !== 'owner') return c.json({ error: 'only the owner can comment' }, 403)
      return this.review(c, route)
    }

    if (target.kind === 'stopped') return c.html(pausedPage(grant === 'owner'), 503)
    // A service can keep the widget out of its own pages; anything not declared in services.yaml has it.
    const review = grant === 'owner' && target.row.services?.find((s) => s.port === route.port)?.review !== false
    return this.proxyHttp(c, route, target.supervisor, grant, review)
  }

  /** A widget comment, sent to the thread as a user message: steering the running turn, else queued behind it. */
  private async review(c: Ctx, route: Route): Promise<Response> {
    const parsed = reviewSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid comment' }, 400)
    try {
      await this.deps.threads.sendMessage(route.threadId, { text: reviewMessage(parsed.data), mode: 'steer' })
      return c.body(null, 204)
    } catch (err) {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400)
      throw err
    }
  }

  /**
   * HTTP into the sandbox over a plain Node request: the browser's body streams
   * through with its Content-Length intact (undici's fetch would re-chunk it and
   * reject `Expect`), and the response streams back unbuffered for SSE.
   */
  private async proxyHttp(c: Ctx, route: Route, supervisor: SupervisorClient, grant: PortalGrant, review: boolean): Promise<Response> {
    const target = supervisor.portalTarget(route.port, route.rest)
    const headers = forwardHeaders(c.req.raw.headers, {
      route,
      grant,
      scheme: this.deps.urls.scheme,
      clientIp: getConnInfo(c).remote.address ?? null,
      supervisor: target.headers,
    })
    const outgoing: Record<string, string> = { host: target.url.host }
    headers.forEach((value, name) => {
      outgoing[name] = value
    })
    const { incoming } = c.env
    const method = c.req.method
    // Whether this response can be injected into is only known once it arrives, but the
    // encoding must be asked for now; documents are the only requests that can qualify.
    if (review && method === 'GET' && (c.req.header('accept') ?? '').includes('text/html')) outgoing['accept-encoding'] = 'identity'
    const upstream = httpRequest({
      host: target.url.hostname,
      port: target.url.port,
      path: target.url.pathname + target.url.search,
      method,
      headers: outgoing,
    })
    connectTimeout(upstream)
    // A browser that navigates away must not leave the app writing into the void.
    c.env.outgoing.once('close', () => {
      if (!c.env.outgoing.writableFinished) upstream.destroy()
    })

    let res: IncomingMessage
    try {
      res = await sendUpstream(upstream, method === 'GET' || method === 'HEAD' ? null : incoming)
    } catch (err) {
      log.warn('portal upstream failed', { id: route.threadId, port: route.port, message: errorMessage(err) })
      if (isUnreachable(err)) return this.unreachable(c, route, grant)
      return c.html(unavailablePage(route.port, 'The sandbox did not answer'), 502)
    }
    const failure = res.headers[PORTAL_ERROR_HEADER]
    if (typeof failure === 'string') {
      const detail = await new Response(Readable.toWeb(res) as ReadableStream)
        .json()
        .then((body) => (typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null))
        .catch(() => null)
      return c.html(unavailablePage(route.port, detail), failure === '504' ? 504 : 502)
    }
    const status = res.statusCode ?? 502
    const resHeaders = responseHeaders(res)
    rewriteResponseHeaders(resHeaders, route, this.deps.urls)
    const off = resHeaders.get(PORTAL_REVIEW_HEADER) === 'off'
    resHeaders.delete(PORTAL_REVIEW_HEADER)
    const bodyless = BODYLESS_STATUS.has(status) || method === 'HEAD'
    const init = { status, statusText: res.statusMessage ?? '', headers: resHeaders }
    if (!bodyless && review && !off && method === 'GET' && isInjectableHtml(resHeaders)) {
      return new Response(await injectReview(res, resHeaders), init)
    }
    const body = bodyless ? null : (Readable.toWeb(res) as ReadableStream)
    if (!body) res.resume()
    return new Response(body, init)
  }

  /**
   * Nothing answered at the supervisor's address. A Docker round trip tells a
   * container that stopped outside pause() (which then shows the paused page and
   * its Wake button) from a supervisor that is merely down.
   */
  private async unreachable(c: Ctx, route: Route, grant: PortalGrant): Promise<Response> {
    await this.deps.threads.checkSandbox(route.threadId)
    const target = await this.deps.threads.portalTarget(route.threadId)
    if (target.kind === 'missing') return c.html(notFoundPage(), 404)
    if (target.kind === 'stopped') return c.html(pausedPage(grant === 'owner'), 503)
    return c.html(unavailablePage(route.port, 'The sandbox did not answer'), 502)
  }

  /**
   * WebSocket upgrades on a portal host. Bytes are tunnelled untouched to the
   * supervisor, which does the same into the app, so any subprotocol works.
   */
  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, threadId: string, portRaw: string): Promise<void> {
    const reject = (status: number, reason: string): void => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
    }
    const hostHeader = req.headers[PORTAL_HOST_HEADER] ?? req.headers['x-forwarded-host']
    const route = parseRoute(threadId, portRaw, req.url ?? '/', typeof hostHeader === 'string' ? hostHeader : undefined, this.deps.urls)
    if (!route) {
      reject(404, 'Not Found')
      return
    }
    const target = await this.deps.threads.portalTarget(route.threadId)
    if (target.kind === 'missing') {
      reject(404, 'Not Found')
      return
    }
    const generation = target.row.portalShares?.[String(route.port)]?.generation ?? 0
    const grant = this.deps.portalAuth.grant(req.headers.cookie, route.host, generation)
    if (!grant) {
      reject(401, 'Unauthorized')
      return
    }
    if (target.kind === 'stopped') {
      reject(503, 'Service Unavailable')
      return
    }
    const upstreamTarget = target.supervisor.portalTarget(route.port, route.rest)
    const headers = forwardHeaders(incomingToHeaders(req.headers), {
      route,
      grant,
      scheme: this.deps.urls.scheme,
      clientIp: req.socket.remoteAddress ?? null,
      supervisor: upstreamTarget.headers,
    })
    const outgoing: Record<string, string> = { host: upstreamTarget.url.host, connection: 'Upgrade', upgrade: String(req.headers.upgrade ?? 'websocket') }
    headers.forEach((value, name) => {
      outgoing[name] = value
    })

    const upstream = httpRequest({
      host: upstreamTarget.url.hostname,
      port: upstreamTarget.url.port,
      path: upstreamTarget.url.pathname + upstreamTarget.url.search,
      method: req.method,
      headers: outgoing,
    })
    connectTimeout(upstream)
    upstream.on('upgrade', (res, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? 'Switching Protocols'}`]
      for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead.length > 0) socket.write(upHead)
      if (head.length > 0) upSocket.write(head)
      socket.pipe(upSocket).pipe(socket)
      upSocket.on('error', () => socket.destroy())
      socket.on('error', () => upSocket.destroy())
    })
    upstream.on('response', (res) => {
      const lines = [`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}`]
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const name = res.rawHeaders[i] ?? ''
        if (!HOP_BY_HOP.includes(name.toLowerCase())) lines.push(`${name}: ${res.rawHeaders[i + 1]}`)
      }
      lines.push('Connection: close')
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      res.pipe(socket)
    })
    upstream.on('error', (err) => {
      log.debug('portal upgrade failed', { id: route.threadId, port: route.port, message: errorMessage(err) })
      if (!isUnreachable(err)) {
        reject(502, 'Bad Gateway')
        return
      }
      void this.deps.threads
        .checkSandbox(route.threadId)
        .then(() => this.deps.threads.portalTarget(route.threadId))
        .then((fresh) => reject(fresh.kind === 'stopped' ? 503 : 502, fresh.kind === 'stopped' ? 'Service Unavailable' : 'Bad Gateway'))
        .catch(() => reject(502, 'Bad Gateway'))
    })
    socket.on('close', () => upstream.destroy())
    upstream.end()
  }

  // ---- session-authenticated helpers ---------------------------------------------

  /** Portal URL for an embedded frame: lands on `path` after signing this host in. */
  async authUrl(threadId: string, port: number, path: string): Promise<PortalAuthUrlResponse> {
    await this.deps.threads.portalShare(threadId, port)
    const origin = this.deps.urls.origin(threadId, port)
    const ret = path.startsWith('/') && !path.startsWith('//') ? path : '/'
    if (!this.deps.portalAuth.enabled) return { url: origin + ret }
    const token = this.deps.portalAuth.mint({ v: 1, t: threadId, p: port, s: 'owner', g: 0, exp: Date.now() + OWNER_TOKEN_TTL_MS, ret })
    return { url: `${origin}${PORTAL_AUTH_PATH}?token=${token}` }
  }

  // ---- sharing --------------------------------------------------------------------

  async share(threadId: string, port: number, hours: ShareHours): Promise<SharePortalResponse> {
    const current = await this.deps.threads.portalShare(threadId, port)
    const exp = Date.now() + hours * 3600_000
    const expiresAt = new Date(exp).toISOString()
    await this.deps.threads.setPortalShare(threadId, port, { generation: current.generation, expiresAt })
    const token = this.deps.portalAuth.mint({ v: 1, t: threadId, p: port, s: 'share', g: current.generation, exp, ret: '/' })
    return { url: `${this.deps.urls.origin(threadId, port)}${PORTAL_AUTH_PATH}?token=${token}`, expiresAt }
  }

  /** Bumps the generation: every link and cookie issued for the port so far stops working. */
  async revoke(threadId: string, port: number): Promise<void> {
    const current = await this.deps.threads.portalShare(threadId, port)
    await this.deps.threads.setPortalShare(threadId, port, { generation: current.generation + 1, expiresAt: null })
  }
}
