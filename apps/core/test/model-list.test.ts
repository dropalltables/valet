import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { LocalRunner } from '../src/agents/local-runner.js'
import { listClaudeModels, listCodexModels } from '../src/agents/model-list.js'
import { fakeCli } from './helpers.js'

/**
 * Fake `claude -p --input-format stream-json`: answers `list_models` control
 * requests. FAKE_MODE selects the failure to simulate.
 */
const FAKE_CLAUDE = String.raw`
const readline = require('node:readline')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const mode = process.env.FAKE_MODE || 'ok'
if (mode === 'exit') {
  process.stderr.write('Invalid API key · Please run /login\n')
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Invalid API key' })
  process.exit(1)
}
const rl = readline.createInterface({ input: process.stdin })
out({ type: 'system', subtype: 'init', session_id: 'sess-1' })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.type !== 'control_request' || msg.request.subtype !== 'list_models') return
  if (mode === 'hang') return
  if (mode === 'malformed') return out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { models: [{ displayName: 'no value' }] } } })
  if (mode === 'error') return out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'not supported here' } })
  out({ type: 'control_response', response: { subtype: 'success', request_id: 'someone-else', response: { models: [] } } })
  out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { models: [
    { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: '' },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: '' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: '' },
    { value: 'claude-3-7-sonnet-20250219', displayName: 'Sonnet 3.7', description: '' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: '' },
  ] } } })
})
rl.on('close', () => process.exit(0))
`

/** Fake `codex app-server`: initialize, then `model/list`. */
const FAKE_CODEX = String.raw`
const readline = require('node:readline')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const mode = process.env.FAKE_MODE || 'ok'
if (mode === 'exit') {
  process.stderr.write('ERROR codex_app_server: failed to start\n')
  process.exit(3)
}
const rl = readline.createInterface({ input: process.stdin })
out({ method: 'remoteControl/status/changed', params: { enabled: false } })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') return out({ id: msg.id, result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' } })
  if (msg.method === 'initialized') return
  if (msg.method !== 'model/list') return
  if (mode === 'hang') return
  if (mode === 'malformed') return out({ id: msg.id, result: { models: 'nope' } })
  if (mode === 'error') return out({ id: msg.id, error: { code: -32001, message: 'unauthorized' } })
  out({ id: msg.id, result: { data: [
    { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6 Astra', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'low' },
    { id: 'gpt-5.5', model: 'gpt-5.5', displayName: '', hidden: false, isDefault: false, supportedReasoningEfforts: [] },
    { id: 'secret', model: 'secret', displayName: 'Secret', hidden: true, isDefault: false, supportedReasoningEfforts: [] },
  ], nextCursor: null } })
})
rl.on('close', () => process.exit(0))
`

let claude: { dir: string; exe: string }
let codex: { dir: string; exe: string }
before(async () => {
  claude = await fakeCli('claude', FAKE_CLAUDE)
  codex = await fakeCli('codex', FAKE_CODEX)
})
after(async () => {
  await fs.rm(claude.dir, { recursive: true, force: true })
  await fs.rm(codex.dir, { recursive: true, force: true })
})

const opts = (cli: { dir: string; exe: string }, mode: string, timeoutMs = 5_000) => ({
  runner: new LocalRunner(),
  cwd: cli.dir,
  env: { PATH: process.env.PATH ?? '', FAKE_MODE: mode },
  executable: cli.exe,
  timeoutMs,
})

test('claude list_models: aliases first, default dropped, other responses ignored', async () => {
  const models = await listClaudeModels(opts(claude, 'ok'))
  assert.deepEqual(models, [
    { id: 'opus[1m]', label: 'Opus (1M context)' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
    { id: 'claude-3-7-sonnet-20250219', label: 'Sonnet 3.7' },
  ])
})

test('claude list_models: malformed response, control error, exit, timeout', async () => {
  await assert.rejects(listClaudeModels(opts(claude, 'malformed')), /unexpected response \(models\.0\.value/)
  await assert.rejects(listClaudeModels(opts(claude, 'error')), /not supported here/)
  await assert.rejects(listClaudeModels(opts(claude, 'exit')), /Invalid API key/)
  const started = Date.now()
  await assert.rejects(listClaudeModels(opts(claude, 'hang', 500)), /no model list within 1 s/)
  assert.ok(Date.now() - started < 4_000, 'the hung CLI is killed promptly')
})

test('codex model/list: hidden dropped, label falls back to id, efforts and default kept', async () => {
  const models = await listCodexModels(opts(codex, 'ok'))
  assert.deepEqual(models, [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', reasoningEfforts: ['low', 'high'], default: true },
    { id: 'gpt-5.5', label: 'gpt-5.5', reasoningEfforts: [] },
  ])
})

test('codex model/list: malformed response, rpc error, exit, timeout', async () => {
  await assert.rejects(listCodexModels(opts(codex, 'malformed')), /unexpected response \(data/)
  await assert.rejects(listCodexModels(opts(codex, 'error')), /codex model\/list: unauthorized/)
  await assert.rejects(listCodexModels(opts(codex, 'exit')), /exited with code 3 before answering: ERROR codex_app_server/)
  const started = Date.now()
  await assert.rejects(listCodexModels(opts(codex, 'hang', 500)), /no response within 1 s|no model list within 1 s/)
  assert.ok(Date.now() - started < 4_000, 'the hung CLI is killed promptly')
})
