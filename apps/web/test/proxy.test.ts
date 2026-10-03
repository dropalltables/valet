import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRequest } from 'next/server'
import { proxy } from '../proxy.js'

test('API bodies are limited even without a Content-Length header', async () => {
  const large = new NextRequest('http://localhost:3000/api/auth/login', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })
  assert.equal(large.headers.get('content-length'), null)
  assert.equal((await proxy(large)).status, 413)

  const small = new NextRequest('http://localhost:3000/api/auth/login', { method: 'POST', body: 'x' })
  assert.match((await proxy(small)).headers.get('x-middleware-rewrite') ?? '', /\/api\/auth\/login$/)
})

test('signed GitHub webhooks retain their 25 MB limit', async () => {
  const webhook = new NextRequest('http://localhost:3000/api/webhooks/github', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })
  assert.match((await proxy(webhook)).headers.get('x-middleware-rewrite') ?? '', /\/api\/webhooks\/github$/)
  const oversized = new NextRequest('http://localhost:3000/api/webhooks/github', { method: 'POST', headers: { 'content-length': String(25 * 1024 * 1024 + 1) }, body: 'x' })
  assert.equal((await proxy(oversized)).status, 413)
})

test('service requests retain the larger upload limit', async () => {
  const request = new NextRequest('http://t-abc-p8000.localhost:3000/upload', {
    method: 'POST',
    headers: { host: 't-abc-p8000.localhost:3000' },
    body: 'x'.repeat(1024 * 1024 + 1),
  })
  const response = await proxy(request)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('x-middleware-rewrite') ?? '', /\/service\/abc\/8000\/upload$/)
})
