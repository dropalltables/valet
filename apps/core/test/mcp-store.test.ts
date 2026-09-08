import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countLookup, resolveUrl, resolveValues } from '../src/mcp/store.js'

test('values keep the stored secret when the caller omits it', () => {
  const values = resolveValues([{ name: 'Authorization' }, { name: 'X-Trace', value: 'on' }], { Authorization: 'Bearer s3cret' })
  assert.deepEqual({ ...values }, { Authorization: 'Bearer s3cret', 'X-Trace': 'on' })
})

test('values reject an omitted value with nothing stored', () => {
  assert.throws(() => resolveValues([{ name: 'Authorization' }], null), /value is required for Authorization/)
  assert.throws(() => resolveValues([{ name: 'Authorization' }], { Other: 'x' }), /value is required for Authorization/)
})

test('values reject duplicates and blank names', () => {
  assert.throws(() => resolveValues([{ name: 'A', value: '1' }, { name: ' A ', value: '2' }], null), /duplicate name: A/)
  assert.throws(() => resolveValues([{ name: 'has space', value: '1' }], null), /invalid name/)
})

test('value names off Object.prototype are plain keys', () => {
  const values = resolveValues([{ name: 'constructor', value: '1' }, { name: '__proto__', value: '2' }], null)
  assert.equal(values['constructor'], '1')
  assert.equal(values['__proto__'], '2')
  assert.deepEqual(Object.keys(values), ['constructor', '__proto__'])
  assert.equal(Object.getPrototypeOf(values), null)
  assert.throws(() => resolveValues([{ name: 'toString' }], resolveValues([{ name: 'x', value: '1' }], null)), /value is required for toString/)
})

test('url accepts either scheme in any case and rejects the rest', () => {
  assert.equal(resolveUrl('  HTTPS://Api.Example.com/mcp  '), 'https://api.example.com/mcp')
  assert.equal(resolveUrl('http://localhost:9000/mcp'), 'http://localhost:9000/mcp')
  for (const bad of ['http://', 'ftp://example.com', 'api.example.com/mcp', 'file:///etc/passwd', '']) {
    assert.throws(() => resolveUrl(bad), /url must be http or https/, bad)
  }
})

test('counts fold applies every all-scope server plus the project links', () => {
  const at = countLookup([
    { scope: 'all', projectId: null },
    { scope: 'all', projectId: null },
    { scope: 'selected', projectId: 'p1' },
    { scope: 'selected', projectId: 'p1' },
    { scope: 'selected', projectId: 'p2' },
    // A `selected` server with no project link applies nowhere.
    { scope: 'selected', projectId: null },
  ])
  assert.equal(at('p1'), 4)
  assert.equal(at('p2'), 3)
  assert.equal(at('p3'), 2)
  assert.equal(countLookup([])('p1'), 0)
})
