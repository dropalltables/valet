import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http, { type Server } from 'node:http'
import zlib from 'node:zlib'
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
/** Past core's injection cap, so the page has to go back to streaming. */
const BIG_HTML_BYTES = 9 * 1024 * 1024
/** How long the streaming page waits before finishing; the shell must not wait with it. */
const SLOW_TAIL_MS = 500
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

function gateway(target: () => PortalTarget, checks: { count: number }, opts: { sent?: string[]; portalAuth?: PortalAuth } = {}): PortalGateway {
  const cfg = loadConfig({ DATABASE_URL: 'postgres://unused', VALET_SECRET_KEY: crypto.randomBytes(32).toString('base64') })
  const cipher = new Cipher(cfg.VALET_SECRET_KEY)
  const threads = {
    portalTarget: async () => target(),
    checkSandbox: async () => {
      checks.count += 1
    },
    sendMessage: async (_id: string, req: { text: string; mode?: string }) => {
      opts.sent?.push(`${req.mode}: ${req.text}`)
      return { turnId: 't1' }
    },
  } as unknown as ThreadService
  return new PortalGateway({
    cfg,
    urls: new PortalUrls(cfg),
    portalAuth: opts.portalAuth ?? new PortalAuth(cipher, false, null as unknown as Db),
    auth: new Auth(cfg, cipher),
    threads,
  })
}

/** Serves a compressed HTML page, an opted-out page, and an echo of the encoding core asked for. */
function fakeApp(): Server {
  return http.createServer((req, res) => {
    if (req.url === `/portal/${PORT}/off`) {
      res.writeHead(200, { 'content-type': 'text/html', 'x-valet-review': 'off' }).end('<html><body>no widget</body></html>')
      return
    }
    if (req.url === `/portal/${PORT}/big`) {
      // Chunked, so nothing declares its size up front.
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<html><body>')
      for (let sent = 0; sent < BIG_HTML_BYTES; sent += 64 * 1024) res.write('x'.repeat(64 * 1024))
      res.end('</body></html>')
      return
    }
    if (req.url === `/portal/${PORT}/slow`) {
      // A streaming render: the shell goes out at once, the rest much later.
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<html><head><title>App</title></head><body>')
      setTimeout(() => res.end('<main>done</main></body></html>'), SLOW_TAIL_MS)
      return
    }
    if (req.url === `/portal/${PORT}/data.json`) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"body":"</body>"}')
      return
    }
    const page = Buffer.from(`<html><body><h1>App</h1><p>accept-encoding: ${String(req.headers['accept-encoding'] ?? 'none')}</p></body></html>`)
    const gz = zlib.gzipSync(page)
    res
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': String(gz.byteLength),
        'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
      })
      .end(gz)
  })
}

async function reviewCore(t: { after: (fn: () => void) => void }, opts: { sent?: string[]; review?: boolean; portalAuth?: PortalAuth } = {}): Promise<number> {
  const app = fakeApp()
  const appPort = await listen(app)
  const row = { portalShares: null, services: [{ port: PORT, review: opts.review ?? true }] }
  const client = new SupervisorClient(`http://127.0.0.1:${appPort}`, 'tok')
  const gw = gateway(() => ({ kind: 'running', row, supervisor: client }) as unknown as PortalTarget, { count: 0 }, opts)
  const core = serve({ fetch: gw.routes().fetch, port: 0, hostname: '127.0.0.1' }) as Server
  const corePort = await new Promise<number>((resolve) => core.once('listening', () => resolve((core.address() as { port: number }).port)))
  t.after(() => {
    core.close()
    app.close()
  })
  return corePort
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string; bytes: Buffer }

function send(port: number, path: string, init: { method: string; headers?: http.OutgoingHttpHeaders; body?: Buffer }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: init.method, headers: { 'x-valet-portal-host': HOST, ...init.headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: bytes.toString('utf8'), bytes })
        })
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

test('portal gateway injects the review widget into an owner\'s HTML', async (t) => {
  const sent: string[] = []
  const corePort = await reviewCore(t, { sent })
  const html = { accept: 'text/html,application/xhtml+xml' }

  const page = await send(corePort, `/portal/${THREAD}/${PORT}/`, { method: 'GET', headers: html })
  assert.equal(page.status, 200)
  // Compression is turned off at the request for documents, so the body arrives readable.
  assert.match(page.body, /accept-encoding: identity/)
  assert.equal(page.headers['content-encoding'], undefined)
  assert.equal(page.headers['content-length'], String(Buffer.byteLength(page.body)))
  const nonce = /<body><script src="\/__valet\/review\.js" defer nonce="([^"]+)"><\/script><h1>App<\/h1>/.exec(page.body)?.[1]
  assert.ok(nonce)
  assert.equal(page.headers['content-security-policy'], `default-src 'self'; script-src 'self' 'nonce-${nonce}'`)

  const script = await send(corePort, `/portal/${THREAD}/${PORT}/__valet/review.js`, { method: 'GET' })
  assert.equal(script.status, 200)
  assert.equal(script.headers['content-type'], 'application/javascript; charset=utf-8')
  assert.match(script.body, /attachShadow/)

  const off = await send(corePort, `/portal/${THREAD}/${PORT}/off`, { method: 'GET', headers: html })
  assert.doesNotMatch(off.body, /review\.js/)
  assert.equal(off.headers['x-valet-review'], undefined)

  const json = await send(corePort, `/portal/${THREAD}/${PORT}/data.json`, { method: 'GET' })
  assert.equal(json.body, '{"body":"</body>"}')

  const comment = await send(corePort, `/portal/${THREAD}/${PORT}/__valet/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ selector: 'h1', path: '/pricing', excerpt: 'App', note: '  Wrong heading  ' })),
  })
  assert.equal(comment.status, 204)
  assert.deepEqual(sent, ['steer: Portal comment on /pricing (h1): Wrong heading\n\nElement text: App'])

  const empty = await send(corePort, `/portal/${THREAD}/${PORT}/__valet/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ selector: 'h1', path: '/', excerpt: '', note: ' ' })),
  })
  assert.equal(empty.status, 400)
  assert.equal(sent.length, 1)
})

test('portal gateway injects into a large chunked page without holding it', async (t) => {
  const corePort = await reviewCore(t)
  const page = await send(corePort, `/portal/${THREAD}/${PORT}/big`, { method: 'GET', headers: { accept: 'text/html' } })
  assert.equal(page.status, 200)
  const tag = '<script src="/__valet/review.js" defer></script>'
  assert.equal(page.bytes.byteLength, '<html><body>'.length + tag.length + BIG_HTML_BYTES + '</body></html>'.length)
  assert.equal(page.body.slice(0, '<html><body>'.length + tag.length), `<html><body>${tag}`)
  // Nothing was buffered, so the app's own bytes came through untouched.
  assert.equal(page.body.slice(-14), '</body></html>')
})

test('portal gateway sends a streaming page\'s shell before the app has finished it', async (t) => {
  const corePort = await reviewCore(t)
  const startedAt = Date.now()
  const { firstByteMs, body } = await new Promise<{ firstByteMs: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: corePort, path: `/portal/${THREAD}/${PORT}/slow`, method: 'GET', headers: { host: HOST, accept: 'text/html' } },
      (res) => {
        let firstByteMs = -1
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          if (firstByteMs < 0) firstByteMs = Date.now() - startedAt
          chunks.push(chunk)
        })
        res.on('end', () => resolve({ firstByteMs, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end()
  })

  assert.ok(firstByteMs < SLOW_TAIL_MS / 2, `first byte after ${firstByteMs} ms`)
  assert.match(body, /<head><script src="\/__valet\/review\.js" defer><\/script><title>App<\/title>/)
  assert.match(body, /<main>done<\/main><\/body><\/html>$/)
})

test('portal gateway leaves pages alone when the service turns review off', async (t) => {
  const corePort = await reviewCore(t, { review: false })
  const page = await send(corePort, `/portal/${THREAD}/${PORT}/`, { method: 'GET', headers: { accept: 'text/html' } })
  assert.equal(page.headers['content-encoding'], 'gzip')
  assert.doesNotMatch(zlib.gunzipSync(page.bytes).toString('utf8'), /review\.js/)
})

test('portal gateway keeps the review widget away from share-link guests', async (t) => {
  const portalAuth = new PortalAuth(new Cipher(crypto.randomBytes(32)), true, null as unknown as Db)
  const guest = portalAuth.cookie(HOST, { v: 1, t: THREAD, p: PORT, s: 'share', g: 0, exp: Date.now() + 60_000, ret: '/' })
  const corePort = await reviewCore(t, { portalAuth })
  const headers = { cookie: `valet_portal=${guest.value}`, accept: 'text/html' }

  const page = await send(corePort, `/portal/${THREAD}/${PORT}/`, { method: 'GET', headers })
  assert.equal(page.headers['content-encoding'], 'gzip')
  assert.doesNotMatch(zlib.gunzipSync(page.bytes).toString('utf8'), /review\.js/)
  assert.equal((await send(corePort, `/portal/${THREAD}/${PORT}/__valet/review.js`, { method: 'GET', headers })).status, 404)
  assert.equal((await send(corePort, `/portal/${THREAD}/${PORT}/__valet/review`, { method: 'POST', headers })).status, 403)
})
