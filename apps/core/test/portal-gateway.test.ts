import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http, { type Server } from 'node:http'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { Auth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { Cipher } from '../src/crypto.js'
import type { Db } from '../src/db/index.js'
import { SupervisorClient } from '../src/docker/supervisor-client.js'
import { PortalAuth } from '../src/portals/auth.js'
import { PortalGateway } from '../src/portals/gateway.js'
import { PortalUrls } from '../src/portals/urls.js'
import type { PortalTarget, ThreadService } from '../src/threads/service.js'

const THREAD = 'abc123'
const PORT = 8000
const HOST = `t-${THREAD}-p${PORT}.localhost:3000`

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}

/** Stands in for the sandbox supervisor: echoes what it received from core. */
function fakeSupervisor(): Server {
  return http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') {
      res.writeHead(401).end()
      return
    }
    if (req.url === `/portal/${PORT}/frame`) {
      res.writeHead(302, {
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        location: `http://localhost:${PORT}/next?x=1`,
      })
      res.end()
      return
    }
    let bytes = 0
    const hash = crypto.createHash('sha256')
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      hash.update(chunk)
    })
    req.on('end', () => {
      const body = JSON.stringify({
        bytes,
        sha256: hash.digest('hex'),
        contentLength: req.headers['content-length'] ?? null,
        expect: req.headers.expect ?? null,
        host: req.headers.host,
      })
      res.writeHead(200, { 'content-type': 'application/json' }).end(body)
    })
  })
}

function gateway(target: () => PortalTarget, checks: { count: number }): PortalGateway {
  const cfg = loadConfig({ DATABASE_URL: 'postgres://unused', VALET_SECRET_KEY: crypto.randomBytes(32).toString('base64') })
  const cipher = new Cipher(cfg.VALET_SECRET_KEY)
  const threads = {
    portalTarget: async () => target(),
    checkSandbox: async () => {
      checks.count += 1
    },
  } as unknown as ThreadService
  return new PortalGateway({
    cfg,
    urls: new PortalUrls(cfg),
    portalAuth: new PortalAuth(cipher, false, null as unknown as Db),
    auth: new Auth(cfg, cipher),
    threads,
  })
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string }

function send(port: number, path: string, init: { method: string; headers?: http.OutgoingHttpHeaders; body?: Buffer }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: init.method, headers: { 'x-valet-portal-host': HOST, ...init.headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (init.body) req.end(init.body)
    else req.end()
  })
}

test('portal gateway streams large bodies with Content-Length intact', async (t) => {
  const supervisor = fakeSupervisor()
  const supervisorPort = await listen(supervisor)
  const row = { portalShares: null }
  const client = new SupervisorClient(`http://127.0.0.1:${supervisorPort}`, 'tok')
  const checks = { count: 0 }
  const gw = gateway(() => ({ kind: 'running', row, supervisor: client }) as unknown as PortalTarget, checks)
  const core = serve({ fetch: gw.routes().fetch, port: 0, hostname: '127.0.0.1' }) as Server
  const corePort = await new Promise<number>((resolve) => core.once('listening', () => resolve((core.address() as { port: number }).port)))
  t.after(() => {
    core.close()
    supervisor.close()
  })

  const body = crypto.randomBytes(6 * 1024 * 1024)
  // curl and other clients add `Expect: 100-continue` above 1 MB; browsers send neither that nor chunked bodies.
  const reply = await send(corePort, `/portal/${THREAD}/${PORT}/upload`, {
    method: 'POST',
    headers: { 'content-length': body.length, expect: '100-continue', 'content-type': 'application/octet-stream' },
    body,
  })
  assert.equal(reply.status, 200)
  const echoed = JSON.parse(reply.body) as { bytes: number; sha256: string; contentLength: string | null; expect: string | null }
  assert.equal(echoed.bytes, body.length)
  assert.equal(echoed.sha256, crypto.createHash('sha256').update(body).digest('hex'))
  assert.equal(echoed.contentLength, String(body.length))
  assert.equal(echoed.expect, null)
  assert.equal(reply.headers['x-valet-portal'], '1')

  const framed = await send(corePort, `/portal/${THREAD}/${PORT}/frame`, { method: 'GET' })
  assert.equal(framed.status, 302)
  assert.equal(framed.headers['x-frame-options'], undefined)
  assert.equal(framed.headers['content-security-policy'], "default-src 'self'")
  assert.equal(framed.headers.location, `http://${HOST}/next?x=1`)
  assert.equal(checks.count, 0)
})

test('portal gateway shows the paused page when the sandbox stopped behind a live handle', async (t) => {
  const closed = http.createServer()
  const closedPort = await listen(closed)
  await new Promise<void>((resolve) => closed.close(() => resolve()))
  const row = { portalShares: null }
  const client = new SupervisorClient(`http://127.0.0.1:${closedPort}`, 'tok')
  const checks = { count: 0 }
  // The first lookup hands out the stale handle; after checkSandbox() the thread reads as stopped.
  const gw = gateway(() => (checks.count === 0 ? { kind: 'running', row, supervisor: client } : { kind: 'stopped', row }) as unknown as PortalTarget, checks)
  const core = serve({ fetch: gw.routes().fetch, port: 0, hostname: '127.0.0.1' }) as Server
  const corePort = await new Promise<number>((resolve) => core.once('listening', () => resolve((core.address() as { port: number }).port)))
  t.after(() => core.close())

  const reply = await send(corePort, `/portal/${THREAD}/${PORT}/`, { method: 'GET' })
  assert.equal(reply.status, 503)
  assert.match(reply.body, /Sandbox is paused/)
  assert.match(reply.body, /Wake/)
  assert.equal(checks.count, 1)
})
