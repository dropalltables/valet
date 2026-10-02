import assert from 'node:assert/strict'
import { ACCOUNT_NAME_RE } from '@valet/shared'
import crypto from 'node:crypto'
import { test } from 'node:test'
import zlib from 'node:zlib'
import type Docker from 'dockerode'
import { formatBytes, imageMediaType } from '@valet/shared'
import { normalizeClaudeTool } from '../src/agents/tool-names.js'
import { parseCookie } from '../src/auth.js'
import { parseSize } from '../src/config.js'
import { parseDeviceLoginOutput } from '../src/credentials/device-login.js'
import { maskToken } from '../src/credentials/store.js'
import { Cipher, timingSafeEqualStrings } from '../src/crypto.js'
import { ACCOUNT_NOUNS, randomAccountName } from '../src/credentials/names.js'
import { diedOfMemory, isLocallyBuilt, reposVolumeName, soleNetworkName, toUsage } from '../src/docker/client.js'
import { parseCommits, parseNumstatZ, splitPatches } from '../src/git/changes.js'
import { managedServicesReplySchema } from '@valet/shared'
import { parseGitHubUrl, parseRepoQuery } from '../src/git/github.js'
import { MAX_HTML_BYTES, allowInjectedScript, decodeHtml, injectWidget, injectionPoint, isInjectableHtml, reviewMessage } from '../src/services/review.js'
import { titleFromPrompt } from '../src/threads/mapper.js'
import type { GitRunner } from '../src/git/changes.js'
import { readSnapshotKey, snapshotKey, snapshotKeyPaths, type SnapshotEntry } from '../src/threads/sandbox-ops.js'

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

type Mount = Docker.ContainerInspectInfo['Mounts'][number]

test('docker environment discovery', () => {
  const none = new Set<string>()
  assert.equal(soleNetworkName({ 'ab12cd_valet': {} }, none), 'ab12cd_valet')
  assert.equal(soleNetworkName({ bridge: {}, 'valet_valet': {} }, none), 'valet_valet')
  assert.throws(() => soleNetworkName({ bridge: {} }, none), /0 Docker networks/)
  assert.throws(() => soleNetworkName({ a: {}, b: {} }, none), /2 Docker networks/)
  // Coolify's shared proxy network alongside the stack's own.
  assert.equal(soleNetworkName({ coolify: {}, 'ab12cd_valet': {} }, new Set(['ab12cd_valet'])), 'ab12cd_valet')
  assert.throws(() => soleNetworkName({ a: {}, b: {} }, new Set(['a', 'b'])), /2 Docker networks/)

  const mount = (over: Partial<Mount>): Mount => ({ Type: 'volume', Source: '', Destination: '/valet/repos', Mode: '', RW: true, Propagation: '', ...over })
  assert.equal(reposVolumeName([mount({ Name: 'ab12cd_repos' })], '/valet/repos'), 'ab12cd_repos')
  assert.equal(reposVolumeName([mount({ Type: 'bind', Source: '/srv/repos' })], '/valet/repos'), '/srv/repos')
  assert.throws(() => reposVolumeName([mount({ Destination: '/other' })], '/valet/repos'), /no mount at/)

  assert.equal(isLocallyBuilt('valet-sandbox:latest'), true)
  assert.equal(isLocallyBuilt('ghcr.io/your-org/valet-sandbox:latest'), false)
  assert.equal(isLocallyBuilt('your-org/valet-sandbox:latest'), false)
})

test('byte formatting', () => {
  assert.equal(formatBytes(4 * 1024 ** 3), '4 GB')
  assert.equal(formatBytes(1.23 * 1024 ** 3), '1.2 GB')
  assert.equal(formatBytes(512 * 1024 ** 2), '512 MB')
  assert.equal(formatBytes(486.4 * 1024 ** 2), '486 MB')
  assert.equal(formatBytes(0), '0 B')
})

test('image media types', () => {
  assert.equal(imageMediaType('assets/Logo.PNG'), 'image/png')
  assert.equal(imageMediaType('a/b/photo.jpeg'), 'image/jpeg')
  assert.equal(imageMediaType('icon.svg'), 'image/svg+xml')
  assert.equal(imageMediaType('apps/core/src/threads.ts'), null)
  assert.equal(imageMediaType('png'), null)
  assert.equal(imageMediaType('.png'), null)
  assert.equal(imageMediaType('dir.png/notes'), null)
})

test('out-of-memory containers', () => {
  const state = { id: 'c1', status: 'exited', ip: null, imageId: 'i1' }
  assert.equal(diedOfMemory({ ...state, running: false, oomKilled: true, exitCode: 137 }), true)
  // A build step the kernel killed leaves the flag set on a container that lives on.
  assert.equal(diedOfMemory({ ...state, running: true, oomKilled: true, exitCode: 0 }), false)
  assert.equal(diedOfMemory({ ...state, running: false, oomKilled: false, exitCode: 137 }), false)
  assert.equal(diedOfMemory({ ...state, running: false, oomKilled: true, exitCode: 0 }), false)
})

test('container stats leave out the page cache', () => {
  const cpu = { cpu_usage: { total_usage: 2e9 }, system_cpu_usage: 100e9, online_cpus: 8 }
  const precpu = { cpu_usage: { total_usage: 1e9 }, system_cpu_usage: 90e9, online_cpus: 8 }
  // cgroup v2: usage is memory.current, inactive_file is the reclaimable cache in it.
  assert.deepEqual(toUsage({ memory_stats: { usage: 301_200_000, stats: { inactive_file: 300_000_000 } }, cpu_stats: cpu, precpu_stats: precpu }), {
    memoryBytes: 1_200_000,
    cpuPercent: 80,
  })
  // cgroup v1 reports the hierarchical figure as well, and Docker prefers it.
  assert.deepEqual(
    toUsage({
      memory_stats: { usage: 500_000_000, stats: { inactive_file: 100_000_000, total_inactive_file: 400_000_000 } },
      cpu_stats: cpu,
      precpu_stats: precpu,
    }).memoryBytes,
    100_000_000,
  )
  // A first sample has no previous CPU reading, and Windows sends no memory breakdown.
  const idle = { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 }
  assert.deepEqual(toUsage({ memory_stats: { usage: 4096 }, cpu_stats: idle, precpu_stats: idle }), { memoryBytes: 4096, cpuPercent: 0 })
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

test('parseRepoQuery accepts owner/repo as well as URLs', () => {
  assert.deepEqual(parseRepoQuery('acme/widgets'), { owner: 'acme', repo: 'widgets' })
  assert.deepEqual(parseRepoQuery(' acme/widgets.git/ '), { owner: 'acme', repo: 'widgets' })
  assert.deepEqual(parseRepoQuery('https://github.com/acme/widgets'), { owner: 'acme', repo: 'widgets' })
  assert.equal(parseRepoQuery('widgets'), null)
  assert.equal(parseRepoQuery('acme/widgets/tree/main'), null)
  assert.equal(parseRepoQuery('https://gitlab.com/acme/widgets'), null)
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

test('snapshot key paths', () => {
  const entries = ['src', 'requirements.txt', 'package.json', 'yarn.lock', 'requirements-dev.txt', 'Cargo.lock', 'lock.json']
  assert.deepEqual(snapshotKeyPaths(entries), ['Cargo.lock', 'requirements-dev.txt', 'requirements.txt', 'yarn.lock'])
  assert.deepEqual(snapshotKeyPaths([]), [])
})

test('snapshot key', () => {
  const entries: SnapshotEntry[] = [
    { path: '.valet/setup', oid: 'a'.repeat(40) },
    { path: 'package-lock.json', oid: 'b'.repeat(40) },
  ]
  const key = snapshotKey('main', entries)
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.equal(snapshotKey('main', entries), key)
  assert.notEqual(snapshotKey('develop', entries), key)

  const edited: SnapshotEntry[] = [{ ...entries[0]!, oid: 'c'.repeat(40) }, entries[1]!]
  assert.notEqual(snapshotKey('main', edited), key)

  // A file that is absent must not hash like one that is present.
  const absent: SnapshotEntry[] = [entries[0]!, { path: 'package-lock.json', oid: null }]
  assert.notEqual(snapshotKey('main', absent), key)

  // Ids may not move between paths: each is hashed with the path it belongs to.
  const swapped: SnapshotEntry[] = [
    { path: '.valet/setup', oid: 'b'.repeat(40) },
    { path: 'package-lock.json', oid: 'a'.repeat(40) },
  ]
  assert.notEqual(snapshotKey('main', swapped), key)

  // Adding a lockfile changes the key even when nothing else moved.
  assert.notEqual(snapshotKey('main', [...entries, { path: 'uv.lock', oid: 'd'.repeat(40) }]), key)
})

test('snapshot key of a ref reads blob ids for the setup script and lockfiles', async () => {
  const setupOid = '1111111111111111111111111111111111111111'
  const lockOid = '2222222222222222222222222222222222222222'
  const calls: string[][] = []
  const run: GitRunner = (argv) => {
    calls.push(argv)
    const stdout = argv.includes('--name-only')
      ? 'README.md\npackage.json\npackage-lock.json\nsrc\nyarn.lock\n'
      : [`100755 blob ${setupOid}\t.valet/setup`, `100644 blob ${lockOid}\tpackage-lock.json`, ''].join('\x00')
    return Promise.resolve({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
  }

  const key = await readSnapshotKey(run, 'FETCH_HEAD', 'main')
  // yarn.lock is in the tree listing but absent from the ls-tree reply: it hashes as missing.
  assert.deepEqual(calls[1], ['git', 'ls-tree', '-z', 'FETCH_HEAD', '--', '.valet/setup', 'package-lock.json', 'yarn.lock'])
  assert.equal(
    key,
    snapshotKey('main', [
      { path: '.valet/setup', oid: setupOid },
      { path: 'package-lock.json', oid: lockOid },
      { path: 'yarn.lock', oid: null },
    ]),
  )
})

test('review widget script tag placement', () => {
  const tag = '<script src="/__valet/review.js" defer></script>'
  // The head comes first, so the tag can go out before the rest of the page exists.
  assert.equal(injectWidget('<html><HEAD><title>t</title></HEAD><body>hi</body></html>', null), `<html><HEAD>${tag}<title>t</title></HEAD><body>hi</body></html>`)
  assert.equal(injectWidget('<html><body class="x">hi</body></html>', null), `<html><body class="x">${tag}hi</body></html>`)
  assert.equal(injectWidget('<p>fragment</p>', 'n1'), '<p>fragment</p><script src="/__valet/review.js" defer nonce="n1"></script>')
  // `'\u0130'.toLowerCase()` is two characters, so a lowercased copy would splice at the wrong offset.
  assert.equal(injectWidget('<body>\u0130stanbul</body>', null), `<body>${tag}\u0130stanbul</body>`)
})

test('the streaming injection point is a byte offset into what has arrived', () => {
  assert.equal(injectionPoint(Buffer.from('<!doctype html><html><he')), null)
  assert.equal(injectionPoint(Buffer.from('<!doctype html><html><head>')), '<!doctype html><html><head>'.length)
  // Multi-byte characters before the tag: the offset counts bytes, not characters.
  const utf8 = Buffer.from('<title>\u0130stanbul</title><body>rest', 'utf8')
  assert.equal(injectionPoint(utf8), utf8.indexOf('<body>') + '<body>'.length)
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
    'Service comment on /pricing?tab=teams (main > section:nth-of-type(2) > h2): This heading is wrong\n\nElement text: Pay as you go',
  )
  assert.equal(reviewMessage({ path: '/', selector: 'img', excerpt: '', note: 'Missing alt' }), 'Service comment on / (img): Missing alt')
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
    browser: false,
    health: null,
    source: 'yaml',
    state: 'running',
    pid: 12,
    uptimeSeconds: 4,
    restarts: 0,
    lastExitCode: null,
    updatedAt: '2026-09-07T00:00:00.000Z',
  }
  assert.equal(managedServicesReplySchema.parse({ services: [legacy] }).services[0]?.review, true)
})

test('randomAccountName is noun-noun-number, within the name rules', () => {
  assert.equal(randomAccountName(() => 0), `${ACCOUNT_NOUNS[0]}-${ACCOUNT_NOUNS[0]}-1`)
  assert.equal(randomAccountName(() => 0.999), `${ACCOUNT_NOUNS[ACCOUNT_NOUNS.length - 1]}-${ACCOUNT_NOUNS[ACCOUNT_NOUNS.length - 1]}-10`)
  for (let i = 0; i < 200; i++) {
    const name = randomAccountName()
    assert.match(name, /^[a-z]+-[a-z]+-(?:[1-9]|10)$/)
    assert.match(name, ACCOUNT_NAME_RE)
  }
})
