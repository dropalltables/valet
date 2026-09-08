import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { GlobalFrame, StreamFrame } from '@valet/shared'
import type { Auth } from '../auth.js'
import { holdBrowserFrames, relay } from '../docker/supervisor-client.js'
import { HttpError } from '../errors.js'
import type { EventLog } from '../events/log.js'
import { errorMessage, logger } from '../logger.js'
import type { ThreadService } from '../threads/service.js'

const log = logger('ws')

const REPLAY_PAGE = 500
/** Application close codes mirror the HTTP statuses the REST routes would answer. */
const CLOSE_NOT_FOUND = 4404
const CLOSE_PAUSED = 4409
const CLOSE_ERROR = 4500

export type WsDeps = { auth: Auth; events: EventLog; threads: ThreadService }

type Route = { kind: 'global' } | { kind: 'stream'; id: string; since: number } | { kind: 'relay'; id: string; target: 'pty' | 'vnc' }

function route(url: URL): Route | null {
  if (url.pathname === '/api/stream') return { kind: 'global' }
  const m = /^\/api\/threads\/([^/]+)\/(stream|pty|vnc)$/.exec(url.pathname)
  if (!m || !m[1]) return null
  if (m[2] === 'stream') {
    const since = Number(url.searchParams.get('since') ?? '0')
    return { kind: 'stream', id: m[1], since: Number.isFinite(since) && since > 0 ? Math.floor(since) : 0 }
  }
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
            void serveStream(ws, deps, target.id, target.since)
            return
          case 'relay':
            void serveRelay(ws, deps, target.id, target.target)
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

async function serveStream(ws: WebSocket, deps: WsDeps, id: string, since: number): Promise<void> {
  let thread
  try {
    thread = await deps.threads.get(id)
  } catch (err) {
    sendJson(ws, { t: 'error', message: errorMessage(err) } satisfies StreamFrame)
    ws.close(err instanceof HttpError && err.status === 404 ? CLOSE_NOT_FOUND : CLOSE_ERROR, errorMessage(err))
    return
  }

  // Subscribe before replaying so nothing appended during the replay is lost; frames
  // that arrive meanwhile are held back and de-duplicated by seq.
  let replaying = true
  let lastSeq = since
  const held: StreamFrame[] = []
  const unsubscribe = deps.events.subscribe(id, (frame: StreamFrame) => {
    if (replaying) {
      held.push(frame)
      return
    }
    if (frame.t === 'event') {
      if (frame.seq <= lastSeq) return
      lastSeq = frame.seq
    }
    sendJson(ws, frame)
  })
  ws.on('close', unsubscribe)
  ws.on('error', unsubscribe)

  try {
    for (;;) {
      const page = await deps.events.replay(id, lastSeq, REPLAY_PAGE)
      for (const e of page.events) {
        lastSeq = e.seq
        sendJson(ws, { t: 'event', seq: e.seq, event: e.event } satisfies StreamFrame)
      }
      if (!page.hasMore) break
    }
  } catch (err) {
    unsubscribe()
    sendJson(ws, { t: 'error', message: errorMessage(err) } satisfies StreamFrame)
    ws.close(CLOSE_ERROR, 'replay failed')
    return
  }

  replaying = false
  for (const frame of held) {
    if (frame.t === 'event') {
      if (frame.seq <= lastSeq) continue
      lastSeq = frame.seq
    }
    sendJson(ws, frame)
  }
  held.length = 0
  const { projectName: _p, diffStats: _d, ...row } = thread
  sendJson(ws, { t: 'thread', thread: row } satisfies StreamFrame)
  sendJson(ws, { t: 'live' } satisfies StreamFrame)
}

async function serveRelay(ws: WebSocket, deps: WsDeps, id: string, target: 'pty' | 'vnc'): Promise<void> {
  const held = holdBrowserFrames(ws)
  let upstream: WebSocket
  try {
    upstream = await deps.threads.openRelay(id, target)
  } catch (err) {
    held.release()
    const status = err instanceof HttpError ? err.status : 500
    const code = status === 404 ? CLOSE_NOT_FOUND : status === 409 ? CLOSE_PAUSED : CLOSE_ERROR
    log.debug('relay refused', { id, target, message: errorMessage(err) })
    ws.close(code, status === 409 ? 'paused' : errorMessage(err).slice(0, 120))
    return
  }
  // The browser may have gone away while the upstream was being dialled; relay()
  // checks and discards the upstream in that case.
  relay(ws, upstream, held)
}
