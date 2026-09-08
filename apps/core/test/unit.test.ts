import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import type Docker from 'dockerode'
import { normalizeClaudeTool } from '../src/agents/tool-names.js'
import { parseCookie } from '../src/auth.js'
import { parseSize } from '../src/config.js'
import { parseDeviceLoginOutput } from '../src/credentials/device-login.js'
import { maskToken } from '../src/credentials/store.js'
import { Cipher, timingSafeEqualStrings } from '../src/crypto.js'
import { isLocallyBuilt, reposVolumeName, soleNetworkName } from '../src/docker/client.js'
import { parseCommits, parseNumstatZ, splitPatches } from '../src/git/changes.js'
import { parseGitHubUrl } from '../src/git/github.js'
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
