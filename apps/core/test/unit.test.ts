import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { normalizeClaudeTool } from '../src/agents/tool-names.js'
import { parseCookie } from '../src/auth.js'
import { parseSize } from '../src/config.js'
import { parseDeviceLoginOutput } from '../src/credentials/device-login.js'
import { maskToken } from '../src/credentials/store.js'
import { Cipher, timingSafeEqualStrings } from '../src/crypto.js'
import { parseCommits, parseNumstatZ, splitPatches } from '../src/git/changes.js'
import { servicesReplySchema } from '@valet/shared'
import { parseGitHubUrl } from '../src/git/github.js'
import { MAX_HTML_BYTES, allowInjectedScript, decodeHtml, injectWidget, isInjectableHtml, reviewMessage } from '../src/portals/review.js'
import { titleFromPrompt } from '../src/threads/mapper.js'

test('cipher round trip and tamper detection', () => {
  const cipher = new Cipher(crypto.randomBytes(32))
  const enc = cipher.encrypt('secret value')
  assert.notEqual(enc, 'secret value')
  assert.equal(cipher.decrypt(enc), 'secret value')
  const tampered = Buffer.from(enc, 'base64')
  tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1)
  assert.throws(() => cipher.decrypt(tampered.toString('base64')))
  assert.equal(timingSafeEqualStrings('abc', 'abc'), true)
  assert.equal(timingSafeEqualStrings('abc', 'abcd'), false)
})

test('config sizes', () => {
  assert.equal(parseSize('4g'), 4 * 1024 ** 3)
  assert.equal(parseSize('512m'), 512 * 1024 ** 2)
  assert.equal(parseSize('1024'), 1024)
  assert.throws(() => parseSize('lots'))
})

test('claude tool names', () => {
  assert.equal(normalizeClaudeTool('Bash'), 'bash')
  assert.equal(normalizeClaudeTool('MultiEdit'), 'edit')
  assert.equal(normalizeClaudeTool('mcp__github__create_issue'), 'mcp:github:create_issue')
  assert.equal(normalizeClaudeTool('SomethingNew'), 'somethingnew')
})

test('token masking', () => {
  assert.equal(maskToken('sk-ant-oat01-abcdefghijklmnop3f9a'), 'sk-ant-oat…3f9a')
  assert.equal(maskToken('ghp_abcdefghijklmnopa1b2'), 'ghp_…a1b2')
  assert.equal(maskToken('sk-proj-abcdefgh1234'), 'sk-proj-ab…1234')
})

test('github url parsing', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/acme/widgets'), { owner: 'acme', repo: 'widgets' })
  assert.deepEqual(parseGitHubUrl('https://github.com/acme/widgets.git/'), { owner: 'acme', repo: 'widgets' })
  assert.deepEqual(parseGitHubUrl('git@github.com:acme/widgets.git'), { owner: 'acme', repo: 'widgets' })
  assert.equal(parseGitHubUrl('https://gitlab.com/acme/widgets'), null)
})

test('numstat -z parsing with renames and binaries', () => {
  const out = '3\t1\tsrc/a.ts\0-\t-\timg.png\0' + '1\t0\t\0old.txt\0new.txt\0'
  assert.deepEqual(parseNumstatZ(out), [
    { path: 'src/a.ts', oldPath: null, additions: 3, deletions: 1 },
    { path: 'img.png', oldPath: null, additions: 0, deletions: 0 },
    { path: 'new.txt', oldPath: 'old.txt', additions: 1, deletions: 0 },
  ])
})

test('patch splitting', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    'diff --git a/old.txt b/renamed.txt',
    'similarity index 100%',
    'rename from old.txt',
    'rename to renamed.txt',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    '',
  ].join('\n')
  const chunks = splitPatches(patch)
  assert.deepEqual(
    chunks.map((c) => [c.path, c.oldPath, c.status]),
    [
      ['src/a.ts', null, 'modified'],
      ['new.txt', null, 'added'],
      ['renamed.txt', 'old.txt', 'renamed'],
      ['gone.txt', null, 'deleted'],
    ],
  )
  assert.ok(chunks[0]?.patch.startsWith('diff --git a/src/a.ts'))
  assert.ok(chunks[0]?.patch.includes('+y'))
})

test('commit log parsing', () => {
  assert.deepEqual(parseCommits('abc\0Fix it\x002026-09-07T10:00:00+02:00\n'), [{ sha: 'abc', subject: 'Fix it', at: '2026-09-07T10:00:00+02:00' }])
})

test('device login output parsing', () => {
  const text = 'Open this link in your browser and sign in\nhttps://auth.openai.com/codex/device\nEnter this one-time code: ABCD-EFGHJ\n'
  assert.deepEqual(parseDeviceLoginOutput(text), { url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGHJ' })
  assert.equal(parseDeviceLoginOutput('Requesting a one-time code...'), null)
  const colored = '1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m0OAZ-VMYP6\x1b[0m\n'
  assert.deepEqual(parseDeviceLoginOutput(colored), { url: 'https://auth.openai.com/codex/device', code: '0OAZ-VMYP6' })
})

test('titles', () => {
  assert.equal(titleFromPrompt('  Fix the\nlogin   bug '), 'Fix the login bug')
  assert.equal(titleFromPrompt('x'.repeat(100)).length, 60)
})

test('cookie parsing survives malformed percent-encoding', () => {
  assert.deepEqual(parseCookie('a=1; valet_session=%E0%A4%A; b=%20x'), { a: '1', valet_session: '%E0%A4%A', b: ' x' })
  assert.deepEqual(parseCookie(undefined), {})
  assert.deepEqual(parseCookie('novalue; =x; k=v=w'), { k: 'v=w' })
})

test('review widget script tag placement', () => {
  assert.equal(injectWidget('<html><body>hi</BODY></html>', null), '<html><body>hi<script src="/__valet/review.js" defer></script></BODY></html>')
  assert.equal(injectWidget('<p>fragment</p>', 'n1'), '<p>fragment</p><script src="/__valet/review.js" defer nonce="n1"></script>')
  // The last close wins, so a `</body>` inside markup does not take the tag with it.
  assert.equal(
    injectWidget('<body><iframe srcdoc="&lt;/body&gt;"></iframe></body>', null),
    '<body><iframe srcdoc="&lt;/body&gt;"></iframe><script src="/__valet/review.js" defer></script></body>',
  )
  // `'\u0130'.toLowerCase()` is two characters, so a lowercased copy would splice at the wrong offset.
  assert.equal(injectWidget('<p>\u0130stanbul</p></body>', null), '<p>\u0130stanbul</p><script src="/__valet/review.js" defer></script></body>')
})

test('review widget nonce goes into the directive that governs scripts', () => {
  const none = new Headers()
  assert.equal(allowInjectedScript(none), null)

  const scriptSrc = new Headers({ 'content-security-policy': "default-src 'self'; script-src 'self' https://cdn.example; img-src *" })
  const nonce = allowInjectedScript(scriptSrc)
  assert.ok(nonce)
  assert.equal(scriptSrc.get('content-security-policy'), `default-src 'self'; script-src 'self' https://cdn.example 'nonce-${nonce}'; img-src *`)

  const fallback = new Headers({ 'content-security-policy': "default-src 'none'; img-src *" })
  const fallbackNonce = allowInjectedScript(fallback)
  assert.equal(fallback.get('content-security-policy'), `default-src 'nonce-${fallbackNonce}'; img-src *`)

  const unrestricted = new Headers({ 'content-security-policy': 'frame-ancestors *' })
  assert.equal(allowInjectedScript(unrestricted), null)
  assert.equal(unrestricted.get('content-security-policy'), 'frame-ancestors *')

  const both = new Headers({ 'content-security-policy': "script-src 'self'", 'content-security-policy-report-only': "img-src 'self'" })
  const bothNonce = allowInjectedScript(both)
  assert.equal(both.get('content-security-policy'), `script-src 'self' 'nonce-${bothNonce}'`)
  assert.equal(both.get('content-security-policy-report-only'), "img-src 'self'")

  // `script-src-elem` governs `<script src>` wherever it appears, and `script-src` is then not consulted.
  const elem = new Headers({ 'content-security-policy': "script-src 'self'; script-src-elem 'self'" })
  const elemNonce = allowInjectedScript(elem)
  assert.equal(elem.get('content-security-policy'), `script-src 'self'; script-src-elem 'self' 'nonce-${elemNonce}'`)

  // Two policies, sent as two headers or one comma-separated header: both have to allow the script.
  const two = new Headers()
  two.append('content-security-policy', "script-src 'self'")
  two.append('content-security-policy', "default-src 'none'; frame-ancestors *")
  const twoNonce = allowInjectedScript(two)
  assert.equal(two.get('content-security-policy'), `script-src 'self' 'nonce-${twoNonce}', default-src 'nonce-${twoNonce}'; frame-ancestors *`)
})

test('review comment message', () => {
  assert.equal(
    reviewMessage({ path: '/pricing?tab=teams', selector: 'main > section:nth-of-type(2) > h2', excerpt: 'Pay as you go', note: 'This heading is wrong' }),
    'Portal comment on /pricing?tab=teams (main > section:nth-of-type(2) > h2): This heading is wrong\n\nElement text: Pay as you go',
  )
  assert.equal(reviewMessage({ path: '/', selector: 'img', excerpt: '', note: 'Missing alt' }), 'Portal comment on / (img): Missing alt')
})

test('review injection only reads HTML it can decode', () => {
  assert.equal(isInjectableHtml(new Headers({ 'content-type': 'text/html' })), true)
  assert.equal(isInjectableHtml(new Headers({ 'content-type': 'text/html; charset=UTF-8' })), true)
  assert.equal(isInjectableHtml(new Headers({ 'content-type': 'text/html; charset=shift_jis' })), false)
  assert.equal(isInjectableHtml(new Headers({ 'content-type': 'text/html+weird' })), false)
  assert.equal(isInjectableHtml(new Headers({ 'content-type': 'application/xhtml+xml' })), false)
  assert.equal(isInjectableHtml(new Headers()), false)

  const page = '<html><body>ok</body></html>'
  assert.equal(decodeHtml(Buffer.from(page), null), page)
  assert.equal(decodeHtml(zlib.gzipSync(page), 'gzip'), page)
  assert.equal(decodeHtml(zlib.brotliCompressSync(Buffer.from(page)), 'br'), page)
  assert.equal(decodeHtml(zlib.deflateSync(page), 'deflate'), page)
  assert.equal(decodeHtml(Buffer.from(page), 'zstd'), null)
  assert.equal(decodeHtml(Buffer.from(page), 'gzip'), null)
  // A bomb: kilobytes on the wire, more than the cap once inflated.
  assert.equal(decodeHtml(zlib.gzipSync(Buffer.alloc(MAX_HTML_BYTES + 1, 0x61)), 'gzip'), null)
})

test('services from a supervisor without the review flag still parse', () => {
  const legacy = {
    name: 'web',
    command: 'npm run dev',
    cwd: '/repo',
    port: 3000,
    url: null,
    portal: false,
    health: null,
    source: 'yaml',
    state: 'running',
    pid: 12,
    uptimeSeconds: 4,
    restarts: 0,
    lastExitCode: null,
    updatedAt: '2026-09-07T00:00:00.000Z',
  }
  assert.equal(servicesReplySchema.parse({ services: [legacy] }).services[0]?.review, true)
})
