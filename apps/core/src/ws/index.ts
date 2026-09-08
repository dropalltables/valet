import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { GlobalFrame, StreamFrame } from '@valet/shared'
import type { Auth } from '../auth.js'
import { holdBrowserFrames, relay } from '../docker/supervisor-client.js'
import { HttpError } from '../errors.js'
import type { EventLog } from '../events/log.js'
import { errorMessage, logger } from '../logger.js'
import type { PortalGateway } from '../portals/gateway.js'
import { toSharedThread } from '../threads/mapper.js'
import type { ThreadService } from '../threads/service.js'
import type { ThreadShares } from '../threads/share.js'

const log = logger('ws')

const REPLAY_PAGE = 500
/** Application close codes mirror the HTTP statuses the REST routes would answer. */
const CLOSE_NOT_FOUND = 4404
const CLOSE_FORBIDDEN = 4403
const CLOSE_PAUSED = 4409
const CLOSE_ERROR = 4500

export type WsDeps = { auth: Auth; events: EventLog; threads: ThreadService; shares: ThreadShares; portals: PortalGateway }

type Route =
  | { kind: 'global' }
  | { kind: 'stream'; id: string; since: number }
  /** Unlisted link: the token stands in for both the session and the thread id. */
  | { kind: 'share'; token: string; since: number }
  | { kind: 'relay'; id: string; target: 'pty' | 'vnc' }
  | { kind: 'logs'; id: string; name: string; lines: number }
  | { kind: 'portal'; threadId: string; port: string }

const DEFAULT_LOG_LINES = 200
const MAX_LOG_LINES = 10_000

function since(url: URL): number {
  const value = Number(url.searchParams.get('since') ?? '0')
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function route(url: URL): Route | null {
  if (url.pathname === '/api/stream') return { kind: 'global' }
  const share = /^\/api\/share\/([^/]+)\/stream$/.exec(url.pathname)
  if (share && share[1]) return { kind: 'share', token: share[1], since: since(url) }
  const portal = /^\/portal\/([^/]+)\/([^/]+)(?:\/|$)/.exec(url.pathname)
  if (portal && portal[1] && portal[2]) return { kind: 'portal', threadId: portal[1], port: portal[2] }
  const logs = /^\/api\/threads\/([^/]+)\/services\/([^/]+)\/logs$/.exec(url.pathname)
  if (logs && logs[1] && logs[2]) {
    const lines = Number(url.searchParams.get('lines') ?? DEFAULT_LOG_LINES)
    return { kind: 'logs', id: logs[1], name: logs[2], lines: Number.isInteger(lines) && lines >= 0 ? Math.min(lines, MAX_LOG_LINES) : DEFAULT_LOG_LINES }
  }
  const m = /^\/api\/threads\/([^/]+)\/(stream|pty|vnc)$/.exec(url.pathname)
  if (!m || !m[1]) return null
  if (m[2] === 'stream') return { kind: 'stream', id: m[1], since: since(url) }
  return { kind: 'relay', id: m[1], target: m[2] as 'pty' | 'vnc' }
}

export function attachWebSockets(server: Server, deps: WsDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  const reject = (socket: Duplex, status: string): void => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  // An exception thrown from an 'upgrade' listener is uncaught and would end the
  // process, so everything here runs inside the try.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const target = route(url)
      if (!target) {
        reject(socket, '404 Not Found')
        return
      }
      if (target.kind === 'portal') {
        // Portal cookies, not the session cookie, authorize this one.
        void deps.portals.upgrade(req, socket, head, target.threadId, target.port).catch((err: unknown) => {
          log.warn('portal upgrade failed', { url: req.url, message: errorMessage(err) })
          if (!socket.destroyed) reject(socket, '502 Bad Gateway')
        })
        return
      }
      if (target.kind === 'share') {
        // The link token, not the session cookie, authorizes this one.
        void deps.shares.resolve(target.token).then(
          (id) => {
            if (!id) {
              reject(socket, '404 Not Found')
              return
            }
            wss.handleUpgrade(req, socket, head, (ws) => void serveStream(ws, deps, id, target.since, 'shared'))
          },
          (err: unknown) => {
            log.warn('share upgrade failed', { url: req.url, message: errorMessage(err) })
            if (!socket.destroyed) reject(socket, '500 Internal Server Error')
          },
        )
        return
      }
      if (!deps.auth.authorizedUpgrade(req)) {
        reject(socket, '401 Unauthorized')
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        switch (target.kind) {
          case 'global':
            serveGlobal(ws, deps)
            return
          case 'stream':
            void serveStream(ws, deps, target.id, target.since, 'owner')
            return
          case 'relay':
            void serveRelay(ws, deps, target.id, () => deps.threads.openRelay(target.id, target.target))
            return
          case 'logs':
            void serveRelay(ws, deps, target.id, () => deps.threads.openServiceLogs(target.id, target.name, target.lines))
            return
        }
      })
    } catch (err) {
      log.warn('upgrade rejected', { url: req.url, message: errorMessage(err) })
      if (!socket.destroyed) reject(socket, '400 Bad Request')
    }
  })

  return wss
}

function sendJson(ws: WebSocket, frame: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
}

function serveGlobal(ws: WebSocket, deps: WsDeps): void {
  const unsubscribe = deps.events.subscribeGlobal((frame: GlobalFrame) => sendJson(ws, frame))
  ws.on('close', unsubscribe)
  ws.on('error', unsubscribe)
}

/**
 * What a link holder is allowed to see: the transcript and the reduced thread row,
 * minus every cost figure, the ids, the sandbox handles, the ports and services, and
 * the container's resource samples.
 */
export function forShared(frame: StreamFrame, projectName: string): StreamFrame | null {
  switch (frame.t) {
    case 'thread':
      return { t: 'thread.shared', thread: toSharedThread({ ...frame.thread, projectName }) }
    case 'event': {
      const event = frame.event
      // `session` names the owner's agent session; `rateLimits` is their account quota.
      if (event.type === 'session') return null
      if (event.type === 'usage') {
        const { costUsd: _cost, ...usage } = event.usage
        return { t: 'event', seq: frame.seq, event: { ...event, usage, rateLimits: null } }
      }
      if (event.type === 'turn.end' && event.usage) {
        const { costUsd: _cost, ...usage } = event.usage
        return { t: 'event', seq: frame.seq, event: { ...event, usage } }
      }
      return frame
    }
    case 'portals':
    case 'services':
    case 'usage':
      return null
    default:
      return frame
  }
}

async function serveStream(ws: WebSocket, deps: WsDeps, id: string, since: number, visibility: 'owner' | 'shared'): Promise<void> {
  let projectName = ''
  const send = (frame: StreamFrame): void => {
    const out = visibility === 'shared' ? forShared(frame, projectName) : frame
    if (out) sendJson(ws, out)
  }
  let thread
  try {
    thread = await deps.threads.get(id)
    projectName = thread.projectName
  } catch (err) {
    send({ t: 'error', message: errorMessage(err) })
    ws.close(err instanceof HttpError && err.status === 404 ? CLOSE_NOT_FOUND : CLOSE_ERROR, errorMessage(err))
    return
  }

  // Subscribe before replaying so nothing appended during the replay is lost; frames
  // that arrive meanwhile are held back and de-duplicated by seq.
  let replaying = true
  let lastSeq = since
  const held: StreamFrame[] = []
  const unsubscribe = deps.events.subscribe(id, visibility, (frame: StreamFrame) => {
    if (replaying) {
      held.push(frame)
      return
    }
    if (frame.t === 'event') {
      if (frame.seq <= lastSeq) return
      lastSeq = frame.seq
    }
    send(frame)
  })
  ws.on('close', unsubscribe)
  ws.on('error', unsubscribe)
  if (visibility === 'shared') {
    // A revoked link must not keep streaming to whoever already had it open.
    const detach = deps.shares.watch(id, () => ws.close(CLOSE_FORBIDDEN, 'revoked'))
    ws.on('close', detach)
    ws.on('error', detach)
  }

  try {
    for (;;) {
      const page = await deps.events.replay(id, lastSeq, REPLAY_PAGE)
      for (const e of page.events) {
        lastSeq = e.seq
        send({ t: 'event', seq: e.seq, event: e.event })
      }
      if (!page.hasMore) break
    }
  } catch (err) {
    unsubscribe()
    send({ t: 'error', message: errorMessage(err) })
    ws.close(CLOSE_ERROR, 'replay failed')
    return
  }

  replaying = false
  for (const frame of held) {
    if (frame.t === 'event') {
      if (frame.seq <= lastSeq) continue
      lastSeq = frame.seq
    }
    send(frame)
  }
  held.length = 0
  const { projectName: _p, diffStats: _d, ...row } = thread
  send({ t: 'thread', thread: row })
  if (visibility === 'owner') {
    const portals = await deps.threads.portals(id).catch(() => [])
    send({ t: 'portals', portals })
    const services = await deps.threads.services(id).catch(() => [])
    send({ t: 'services', services })
  }
  send({ t: 'live' })
  if (visibility === 'owner') {
    // A sample takes about a second on the daemon, so it follows the live frame; without
    // it the header would be missing its memory and CPU until the next 10 s tick.
    void deps.threads.sampleUsage(id).catch((err: unknown) => log.debug('usage sample failed', { id, message: errorMessage(err) }))
  }
}

async function serveRelay(ws: WebSocket, _deps: WsDeps, id: string, open: () => Promise<WebSocket>): Promise<void> {
  const held = holdBrowserFrames(ws)
  let upstream: WebSocket
  try {
    upstream = await open()
  } catch (err) {
    held.release()
    const status = err instanceof HttpError ? err.status : 500
    const code = status === 404 ? CLOSE_NOT_FOUND : status === 409 ? CLOSE_PAUSED : CLOSE_ERROR
    log.debug('relay refused', { id, message: errorMessage(err) })
    ws.close(code, status === 409 ? 'paused' : errorMessage(err).slice(0, 120))
    return
  }
  // The browser may have gone away while the upstream was being dialled; relay()
  // checks and discards the upstream in that case.
  relay(ws, upstream, held)
}
