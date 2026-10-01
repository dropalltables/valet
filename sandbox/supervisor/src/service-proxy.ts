import { request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { SERVICE_APP_AUTHORIZATION_HEADER, SERVICE_ERROR_HEADER } from '@valet/shared'
import { sendJson } from './http.js'

/** Time allowed for the app to accept the connection and start answering; nothing bounds the response itself. */
const CONNECT_TIMEOUT_MS = 30_000

/** Headers that describe this hop rather than the message, and the supervisor's own bearer token. */
const DROPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'authorization',
  SERVICE_APP_AUTHORIZATION_HEADER,
])
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding'])

export type ServiceTarget = { port: number; path: string }

/** `/service/8000/some/path?q=1` -> port 8000, path `/some/path?q=1`. Null when not a service URL. */
export function parseServiceUrl(rawUrl: string): ServiceTarget | null {
  const m = /^\/service\/(\d+)(\/[^\s]*)?$/.exec(rawUrl)
  if (!m || !m[1]) return null
  const port = Number(m[1])
  if (port < 1 || port > 65535) return null
  return { port, path: m[2] ?? '/' }
}

/**
 * Apps bind to localhost and check Host (Vite `server.allowedHosts`, Django
 * `ALLOWED_HOSTS`), so the Host they see is `localhost:<port>`; the browser-facing
 * values travel in X-Forwarded-* set by core.
 */
function appHeaders(incoming: IncomingHttpHeaders, port: number, upgrade: boolean): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(key)) continue
    out[key] = value
  }
  out.host = `localhost:${port}`
  const appAuth = incoming[SERVICE_APP_AUTHORIZATION_HEADER]
  if (typeof appAuth === 'string') out.authorization = appAuth
  if (upgrade) {
    out.connection = 'Upgrade'
    out.upgrade = incoming.upgrade
  }
  return out
}

function upstreamError(port: number, err: NodeJS.ErrnoException): { status: number; message: string } {
  if (err.code === 'ECONNREFUSED') return { status: 502, message: 'Connection refused' }
  if (err.code === 'ETIMEDOUT' || err.message === 'connect timeout') return { status: 504, message: `No answer within ${CONNECT_TIMEOUT_MS / 1000} s` }
  return { status: 502, message: err.message }
}

export function proxyServiceRequest(target: ServiceTarget, req: IncomingMessage, res: ServerResponse): void {
  const upstream = request({
    host: '127.0.0.1',
    port: target.port,
    path: target.path,
    method: req.method,
    headers: appHeaders(req.headers, target.port, false),
  })
  const connectTimer = setTimeout(() => upstream.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS)

  upstream.on('response', (up) => {
    clearTimeout(connectTimer)
    const headers: IncomingHttpHeaders = {}
    for (const [key, value] of Object.entries(up.headers)) {
      if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(key)) headers[key] = value
    }
    res.writeHead(up.statusCode ?? 502, up.statusMessage, headers)
    up.pipe(res)
    up.on('error', () => res.destroy())
  })
  upstream.on('error', (err: NodeJS.ErrnoException) => {
    clearTimeout(connectTimer)
    if (res.headersSent) {
      res.destroy()
      return
    }
    const { status, message } = upstreamError(target.port, err)
    res.setHeader(SERVICE_ERROR_HEADER, String(status))
    sendJson(res, status, { error: message, port: target.port })
  })
  // A browser that navigates away mid-response must not leave the app writing into the void.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy()
  })
  req.pipe(upstream)
}

/**
 * Byte-transparent WebSocket tunnel: the app's 101 is relayed as-is, then the two
 * sockets are piped. Nothing in between parses frames, so extensions and
 * subprotocols negotiate end to end.
 */
export function proxyServiceUpgrade(target: ServiceTarget, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const upstream = request({
    host: '127.0.0.1',
    port: target.port,
    path: target.path,
    method: req.method,
    headers: appHeaders(req.headers, target.port, true),
  })
  const connectTimer = setTimeout(() => upstream.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS)
  const fail = (status: number, reason: string): void => {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\n${SERVICE_ERROR_HEADER}: ${status}\r\nConnection: close\r\n\r\n`)
  }

  upstream.on('upgrade', (up, upSocket, upHead) => {
    clearTimeout(connectTimer)
    const lines = [`HTTP/1.1 ${up.statusCode ?? 101} ${up.statusMessage ?? 'Switching Protocols'}`]
    for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upHead.length > 0) socket.write(upHead)
    if (head.length > 0) upSocket.write(head)
    socket.pipe(upSocket).pipe(socket)
    upSocket.on('error', () => socket.destroy())
    socket.on('error', () => upSocket.destroy())
  })
  // The app answered without upgrading (404, 403): relay that answer and close.
  upstream.on('response', (up) => {
    clearTimeout(connectTimer)
    const lines = [`HTTP/1.1 ${up.statusCode ?? 502} ${up.statusMessage ?? ''}`]
    for (let i = 0; i < up.rawHeaders.length; i += 2) {
      const name = up.rawHeaders[i] ?? ''
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) lines.push(`${name}: ${up.rawHeaders[i + 1]}`)
    }
    lines.push('Connection: close')
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    up.pipe(socket)
  })
  upstream.on('error', (err: NodeJS.ErrnoException) => {
    clearTimeout(connectTimer)
    const { status } = upstreamError(target.port, err)
    fail(status, status === 504 ? 'Gateway Timeout' : 'Bad Gateway')
  })
  socket.on('close', () => upstream.destroy())
  upstream.end()
}
