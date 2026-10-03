import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import WebSocket from 'ws'
import { Auth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { Cipher } from '../src/crypto.js'
import type { Db } from '../src/db/index.js'
import type { EventLog } from '../src/events/log.js'
import type { ServiceGateway } from '../src/services/gateway.js'
import type { ThreadShares } from '../src/threads/share.js'
import type { ThreadService } from '../src/threads/service.js'
import { attachWebSockets } from '../src/ws/index.js'

test('owner WebSockets reject service origins and close on logout', async () => {
  const cfg = loadConfig({ DATABASE_URL: 'postgres://unused', VALET_SECRET_KEY: crypto.randomBytes(32).toString('base64'), VALET_BASE_URL: 'http://localhost:3000' })
  const auth = new Auth(cfg, new Cipher(cfg.VALET_SECRET_KEY), null as unknown as Db)
  const server = createServer()
  const events = { subscribeGlobal: () => () => undefined } as unknown as EventLog
  const wss = attachWebSockets(server, { auth, events, threads: null as unknown as ThreadService, shares: null as unknown as ThreadShares, services: null as unknown as ServiceGateway })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `ws://127.0.0.1:${address.port}/api/stream`

  try {
    const denied = new WebSocket(url, { origin: 'http://t-abc-p8000.localhost:3000' })
    const status = await new Promise<number>((resolve, reject) => {
      denied.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      denied.once('error', reject)
    })
    assert.equal(status, 403)

    const owner = new WebSocket(url, { origin: 'http://localhost:3000' })
    await new Promise<void>((resolve, reject) => {
      owner.once('open', resolve)
      owner.once('error', reject)
    })
    const closed = new Promise<void>((resolve) => owner.once('close', () => resolve()))
    assert.equal((await auth.routes().request('/api/auth/logout', { method: 'POST' })).status, 204)
    await closed
  } finally {
    wss.close()
    server.closeAllConnections()
    server.close()
  }
})
