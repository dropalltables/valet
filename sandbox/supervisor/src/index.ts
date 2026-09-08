import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { SANDBOX } from '@valet/shared'
import { authorized, requireToken } from './env.js'
import { handleExec } from './exec.js'
import { fsList, fsMkdir, fsRead, fsWrite } from './fs.js'
import { health } from './health.js'
import { HttpError, parseJson, readBody, sendJson } from './http.js'
import { parsePortalUrl, proxyPortalRequest, proxyPortalUpgrade } from './portal.js'
import { listPorts, parseExcludePids } from './ports.js'
import { handlePty } from './pty.js'
import { RUN_BODY_LIMIT, parseRunRequest, runToCompletion } from './run.js'
import { connectVnc, relayVnc } from './vnc.js'

const token = requireToken()

function logRequest(method: string | undefined, url: string | undefined, status: number, startedAt: number): void {
  console.log(`${method ?? '-'} ${url ?? '-'} ${status} ${Date.now() - startedAt}ms`)
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const key = `${req.method} ${url.pathname}`
  switch (key) {
    case 'GET /health':
      return sendJson(res, 200, await health())
    case 'POST /run':
      return sendJson(res, 200, await runToCompletion(parseRunRequest(parseJson(await readBody(req, RUN_BODY_LIMIT)))))
    case 'GET /fs/list':
      return fsList(url, res)
    case 'GET /fs/read':
      return fsRead(url, res)
    case 'PUT /fs/write':
      return fsWrite(url, req, res)
    case 'POST /fs/mkdir':
      return fsMkdir(req, res)
    case 'GET /ports':
      return sendJson(res, 200, await listPorts(parseExcludePids(url.searchParams.get('excludePids'))))
    default:
      throw new HttpError(404, 'not found')
  }
}

const server = createServer((req, res) => {
  const startedAt = Date.now()
  res.once('close', () => logRequest(req.method, req.url, res.statusCode, startedAt))

  if (!authorized(req, token)) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }
  // Portal paths keep their raw form: the app decides how to decode them.
  const portal = parsePortalUrl(req.url ?? '/')
  if (portal) {
    proxyPortalRequest(portal, req, res)
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  route(req, res, url).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    if (status === 500) console.error(`${req.method} ${url.pathname}: ${message}`)
    if (res.headersSent) res.destroy()
    else sendJson(res, status, { error: message })
  })
})

const sockets = {
  exec: new WebSocketServer({ noServer: true }),
  pty: new WebSocketServer({ noServer: true }),
  vnc: new WebSocketServer({ noServer: true }),
}
sockets.exec.on('connection', handleExec)
sockets.pty.on('connection', handlePty)

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

server.on('upgrade', (req, socket, head) => {
  const startedAt = Date.now()
  const url = new URL(req.url ?? '/', 'http://localhost')
  const done = (status: number): void => logRequest(req.method, req.url, status, startedAt)

  if (!authorized(req, token)) {
    rejectUpgrade(socket, 401, 'Unauthorized')
    done(401)
    return
  }

  const portal = parsePortalUrl(req.url ?? '/')
  if (portal) {
    proxyPortalUpgrade(portal, req, socket, head)
    socket.once('close', () => done(101))
    return
  }

  /**
   * ws completes the handshake synchronously, or aborts it (bad headers, socket
   * already gone) without calling back; the return value tells the two apart.
   */
  const accept = (wss: WebSocketServer, onOpen: (ws: import('ws').WebSocket) => void): boolean => {
    let accepted = false
    wss.handleUpgrade(req, socket, head, (ws) => {
      accepted = true
      done(101)
      onOpen(ws)
    })
    if (!accepted) done(400)
    return accepted
  }

  switch (url.pathname) {
    case '/exec':
      accept(sockets.exec, (ws) => sockets.exec.emit('connection', ws, req))
      return
    case '/pty':
      accept(sockets.pty, (ws) => sockets.pty.emit('connection', ws, req))
      return
    case '/vnc':
      connectVnc().then(
        (vnc) => {
          if (!accept(sockets.vnc, (ws) => relayVnc(ws, vnc))) vnc.destroy()
        },
        () => {
          rejectUpgrade(socket, 503, 'Service Unavailable')
          done(503)
        },
      )
      return
    default:
      rejectUpgrade(socket, 404, 'Not Found')
      done(404)
  }
})

server.listen(SANDBOX.supervisorPort, '0.0.0.0', () => {
  console.log(`supervisor listening on :${SANDBOX.supervisorPort} as uid ${process.getuid?.() ?? '?'}`)
})

const shutdown = (): void => {
  server.close()
  for (const wss of Object.values(sockets)) for (const client of wss.clients) client.terminate()
  setTimeout(() => process.exit(0), 1_000).unref()
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
