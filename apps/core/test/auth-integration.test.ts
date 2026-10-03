import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { after, before, test } from 'node:test'
import { Auth, SESSION_COOKIE } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { Cipher } from '../src/crypto.js'
import { createDb, type Db } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { authSessions, authState } from '../src/db/schema.js'
import { SERVICE_COOKIE, ServiceAuth } from '../src/services/auth.js'

const databaseUrl = process.env.VALET_TEST_DATABASE_URL
const dbTest = { skip: databaseUrl ? false : 'set VALET_TEST_DATABASE_URL to a scratch Postgres' }
let db: Db
let close: () => Promise<void>

before(async () => {
  if (!databaseUrl) return
  const created = createDb(databaseUrl)
  db = created.db
  close = () => created.pool.end()
  await runMigrations(db)
  await db.delete(authSessions)
  await db.delete(authState)
})

after(async () => {
  if (close) await close()
})

test('sessions revoke individually and password rotation revokes owner service cookies', dbTest, async () => {
  const secret = crypto.randomBytes(32).toString('base64')
  const config = (password: string) => loadConfig({
    DATABASE_URL: databaseUrl,
    VALET_SECRET_KEY: secret,
    VALET_BASE_URL: 'https://valet.example.com',
    VALET_PASSWORD: password,
  })
  const cipher = new Cipher(config('first phrase').VALET_SECRET_KEY)
  const auth = new Auth(config('first phrase'), cipher, db)
  await auth.load()
  const service = new ServiceAuth(cipher, true, db)
  await service.load()
  auth.onLogout(() => service.revokeOwners())
  const host = 't-abc-p8000.valet.example.com'
  const ownerToken = () => service.mint({ v: 1, t: 'abc', p: 8000, s: 'owner', g: 0, exp: Date.now() + 60_000, ret: '/' })
  const beforeLogoutToken = ownerToken()
  assert.ok(service.read(beforeLogoutToken))
  const serviceCookie = service.cookie(host, { v: 1, t: 'abc', p: 8000, s: 'owner', g: 0, exp: Date.now() + 60_000, ret: '/' }).value
  assert.equal(service.grant(`${SERVICE_COOKIE}=${serviceCookie}`, host, 0), 'owner')

  const login = async () => {
    const response = await auth.routes().request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'first phrase' }),
    })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]!
  }
  const first = await login()
  const second = await login()
  assert.notEqual(first, second)
  assert.equal((await db.select().from(authSessions)).length, 2)
  assert.ok(!(await db.select().from(authSessions)).some((row) => first.includes(row.tokenHash)))

  const logout = await auth.routes().request('/api/auth/logout', { method: 'POST', headers: { cookie: first } })
  assert.equal(logout.status, 204)
  assert.equal(await auth.authorizedCookieHeader(first), false)
  assert.equal(await auth.authorizedCookieHeader(second), true)
  assert.equal(service.read(beforeLogoutToken), null)
  assert.equal(service.grant(`${SERVICE_COOKIE}=${serviceCookie}`, host, 0), null)

  const afterLogoutToken = ownerToken()
  const afterLogout = service.cookie(host, { v: 1, t: 'abc', p: 8000, s: 'owner', g: 0, exp: Date.now() + 60_000, ret: '/' }).value
  assert.equal(service.grant(`${SERVICE_COOKIE}=${afterLogout}`, host, 0), 'owner')

  const rotated = new Auth(config('second phrase'), cipher, db)
  await rotated.load()
  await service.load()
  assert.equal(service.read(afterLogoutToken), null)
  assert.equal(await rotated.authorizedCookieHeader(second), false)
  assert.equal(service.grant(`${SESSION_COOKIE}=ignored; ${SERVICE_COOKIE}=${afterLogout}`, host, 0), null)
  assert.equal((await db.select().from(authSessions)).length, 0)
})
