import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { SANDBOX } from '@valet/shared'
import { authorized, requireToken } from './env.js'
import { handleExec } from './exec.js'
import { fsList, fsMkdir, fsRead, fsWrite } from './fs.js'
import { health } from './health.js'
import { HttpError, parseJson, readBody, sendJson } from './http.js'
import { parseServiceUrl, proxyServiceRequest, proxyServiceUpgrade } from './service-proxy.js'
import { listPorts, parseExcludePids } from './ports.js'
import { handlePty } from './pty.js'
import { RUN_BODY_LIMIT, parseRunRequest, runToCompletion } from './run.js'
import { ServiceManager } from './services/manager.js'
import { parseLines, parseLogsUpgrade, routeServices, tailLogs } from './services/routes.js'
import { connectVnc, relayVnc } from './vnc.js'

const token = requireToken()
const services = new ServiceManager()

// A rejection nobody caught must not take /health, /exec, and /pty down with it: the
// process is restarted by supervisord, but the thread is unreachable until then.
process.on('unhandledRejection', (reason: unknown) => {
  console.error(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
})

function logRequest(via: string, method: string | undefined, url: string | undefined, status: number, startedAt: number): void {
  console.log(`${via} ${method ?? '-'} ${url ?? '-'} ${status} ${Date.now() - startedAt}ms`)
}

/**
 * The control socket is for the `valet` CLI inside the container, without the
 * token: only what the CLI needs is reachable there, so the socket never becomes
 * a way for agent processes to run /exec, read files, or reach the desktop.
 */
function allowedLocally(method: string | undefined, pathname: string): boolean {
  if (method === 'GET' && (pathname === '/health' || pathname === '/ports')) return true
  return pathname === '/managed-services' || pathname.startsWith('/managed-services/')
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (await routeServices(services, req, res, url)) return
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
      return sendJson(res, 200, await listPorts(parseExcludePids(url.searchParams.get('excludePids')), services.portOwners()))
    default:
      throw new HttpError(404, 'not found')
  }
}

function requestHandler(via: 'tcp' | 'socket') {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const startedAt = Date.now()
    res.once('close', () => logRequest(via, req.method, req.url, res.statusCode, startedAt))

    const url = new URL(req.url ?? '/', 'http://localhost')
    if (via === 'socket') {
      if (!allowedLocally(req.method, url.pathname)) {
        sendJson(res, 403, { error: 'not available on the control socket' })
        return
      }
    } else {
      if (!authorized(req, token)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      // Service paths keep their raw form: the app decides how to decode them.
      const service = parseServiceUrl(req.url ?? '/')
      if (service) {
        proxyServiceRequest(service, req, res)
        return
      }
    }
    route(req, res, url).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      const message = err instanceof Error ? err.message : String(err)
      if (status === 500) console.error(`${req.method} ${url.pathname}: ${message}`)
      if (res.headersSent) res.destroy()
      else sendJson(res, status, { error: message })
    })
  }
}

const sockets = {
  exec: new WebSocketServer({ noServer: true }),
  pty: new WebSocketServer({ noServer: true }),
  vnc: new WebSocketServer({ noServer: true }),
  logs: new WebSocketServer({ noServer: true }),
}
sockets.exec.on('connection', handleExec)
sockets.pty.on('connection', handlePty)

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function upgradeHandler(via: 'tcp' | 'socket') {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const startedAt = Date.now()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const done = (status: number): void => logRequest(via, req.method, req.url, status, startedAt)

    if (via === 'socket') {
      if (!allowedLocally(req.method, url.pathname)) {
        rejectUpgrade(socket, 403, 'Forbidden')
        done(403)
        return
      }
    } else {
      if (!authorized(req, token)) {
        rejectUpgrade(socket, 401, 'Unauthorized')
        done(401)
        return
      }
      const service = parseServiceUrl(req.url ?? '/')
      if (service) {
        proxyServiceUpgrade(service, req, socket, head)
        socket.once('close', () => done(101))
        return
      }
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

    const logsService = parseLogsUpgrade(url)
    if (logsService !== null) {
      let file: string
      let lines: number
      try {
        file = services.logPath(logsService)
        lines = parseLines(url)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500
        rejectUpgrade(socket, status, status === 404 ? 'Not Found' : 'Bad Request')
        done(status)
        return
      }
      accept(sockets.logs, (ws) => tailLogs(ws, file, lines))
      return
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
            rejectUpgrade(socket, 503, 'ManagedService Unavailable')
            done(503)
          },
        )
        return
      default:
        rejectUpgrade(socket, 404, 'Not Found')
        done(404)
    }
  }
}

const server = createServer(requestHandler('tcp'))
server.on('upgrade', upgradeHandler('tcp'))
server.listen(SANDBOX.supervisorPort, '0.0.0.0', () => {
  console.log(`supervisor listening on :${SANDBOX.supervisorPort} as uid ${process.getuid?.() ?? '?'}`)
})

// A stopped container keeps the home volume, and with it a stale socket file.
mkdirSync(dirname(SANDBOX.controlSocket), { recursive: true })
if (existsSync(SANDBOX.controlSocket)) rmSync(SANDBOX.controlSocket)
const control = createServer(requestHandler('socket'))
control.on('upgrade', upgradeHandler('socket'))
control.listen(SANDBOX.controlSocket, () => {
  chmodSync(SANDBOX.controlSocket, 0o600)
  console.log(`control socket at ${SANDBOX.controlSocket}`)
})

services.bootEnsure()

const shutdown = (): void => {
  server.close()
  control.close()
  for (const wss of Object.values(sockets)) for (const client of wss.clients) client.terminate()
  setTimeout(() => process.exit(0), 1_000).unref()
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
