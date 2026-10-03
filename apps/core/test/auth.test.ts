import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import { Auth } from '../src/auth.js'
import { loadConfig } from '../src/config.js'
import { Cipher } from '../src/crypto.js'
import type { Db } from '../src/db/index.js'

function auth(): Auth {
  const cfg = loadConfig({
    DATABASE_URL: 'postgres://unused',
    VALET_SECRET_KEY: crypto.randomBytes(32).toString('base64'),
    VALET_BASE_URL: 'https://valet.example.com',
    VALET_PASSWORD: 'correct horse',
  })
  return new Auth(cfg, new Cipher(cfg.VALET_SECRET_KEY), {} as Db)
}

test('auth mutations reject cross-origin browser requests', async () => {
  const res = await auth().routes().request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ password: 'correct horse' }),
  })
  assert.equal(res.status, 403)
})

test('bodyless login is parsed normally rather than rejected by body cap', async () => {
  const res = await auth().routes().request('/api/auth/login', { method: 'POST' })
  assert.equal(res.status, 400)
})

test('unauthenticated logout does not run revocation hooks', async () => {
  const instance = auth()
  let revoked = false
  instance.onLogout(async () => {
    revoked = true
  })
  const res = await instance.routes().request('/api/auth/logout', { method: 'POST' })
  assert.equal(res.status, 401)
  assert.equal(revoked, false)
})

test('login throttling ignores spoofed forwarding headers', async () => {
  const app = auth().routes()
  for (let i = 0; i < 8; i++) {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${i + 1}` },
      body: JSON.stringify({ password: 'wrong' }),
    })
    assert.equal(res.status, 401)
  }
  const blocked = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.200' },
    body: JSON.stringify({ password: 'correct horse' }),
  })
  assert.equal(blocked.status, 429)
})

test('origin checks reject same-site portal requests but allow same-origin browser requests', () => {
  const instance = auth()
  assert.equal(instance.originAllowed(undefined, 'same-site'), false)
  assert.equal(instance.originAllowed(undefined, 'same-origin'), true)
  assert.equal(instance.originAllowed('https://valet.example.com', 'same-origin'), true)
  assert.equal(instance.originAllowed('https://evil.example.com', 'same-origin'), false)
})
