import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebSocket } from 'ws'
import { createManagedServiceRequestSchema, type ManagedServiceLogsFrame } from '@valet/shared'
import { HttpError, MiB, parseJson, readBody, sendEmpty, sendJson } from '../http.js'
import type { ServiceManager } from './manager.js'

const PATH_RE = /^\/managed-services(?:\/([^/]+)(?:\/(start|stop|restart|logs))?)?$/
const LOGS_RE = /^\/managed-services\/([^/]+)\/logs$/
const DEFAULT_LINES = 200
const MAX_LINES = 10_000

export function parseLines(url: URL): number {
  const raw = url.searchParams.get('lines')
  if (raw === null) return DEFAULT_LINES
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'lines must be a non-negative integer')
  return Math.min(n, MAX_LINES)
}

/** True when the request was a /managed-services path (and has been answered). */
export async function routeServices(manager: ServiceManager, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const m = PATH_RE.exec(url.pathname)
  if (!m) return false
  const name = m[1]
  const action = m[2]
  const method = req.method ?? 'GET'

  if (name === undefined) {
    if (method === 'GET') {
      sendJson(res, 200, { services: await manager.list() })
      return true
    }
    if (method === 'POST') {
      const parsed = createManagedServiceRequestSchema.safeParse(parseJson(await readBody(req, MiB)))
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
      sendJson(res, 201, await manager.create(parsed.data))
      return true
    }
    throw new HttpError(405, 'method not allowed')
  }
  if (name === 'ensure' && action === undefined && method === 'POST') {
    sendJson(res, 200, await manager.ensure())
    return true
  }
  if (action === undefined) {
    if (method === 'GET') {
      sendJson(res, 200, await manager.get(name))
      return true
    }
    if (method === 'DELETE') {
      await manager.remove(name)
      sendEmpty(res, 204)
      return true
    }
    throw new HttpError(405, 'method not allowed')
  }
  if (action === 'logs') {
    if (method !== 'GET') throw new HttpError(405, 'method not allowed')
    const text = await manager.readLogs(name, parseLines(url))
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
    res.end(text)
    return true
  }
  if (method !== 'POST') throw new HttpError(405, 'method not allowed')
  const reply = action === 'start' ? await manager.start(name) : action === 'stop' ? await manager.stop(name) : await manager.restart(name)
  sendJson(res, 200, reply)
  return true
}

/** ManagedService name for a `/managed-services/:name/logs` upgrade, or null. */
export function parseLogsUpgrade(url: URL): string | null {
  return LOGS_RE.exec(url.pathname)?.[1] ?? null
}

/** `tail -F` of the service log into base64 frames; `-F` follows across supervisord's rotation and a file that does not exist yet. */
export function tailLogs(ws: WebSocket, file: string, lines: number): void {
  const tail = spawn('tail', ['-n', String(lines), '-F', file], { stdio: ['ignore', 'pipe', 'ignore'] })
  tail.stdout.on('data', (chunk: Buffer) => {
    const frame: ManagedServiceLogsFrame = { t: 'data', data: chunk.toString('base64') }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  })
  tail.once('exit', () => ws.close())
  tail.once('error', () => ws.close())
  ws.once('close', () => tail.kill())
}
