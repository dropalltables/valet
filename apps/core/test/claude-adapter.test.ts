import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { ThreadEvent } from '@valet/shared'
import { ClaudeAdapter } from '../src/agents/claude.js'
import { LocalRunner } from '../src/agents/local-runner.js'
import { fakeCli, recorder, types } from './helpers.js'

/**
 * Replays canned stream-json lines for each stdin user message. Turn 1 streams text,
 * a tool call with partial input, and a tool result; turn 2 asks for permission and
 * echoes the decision; an interrupt control request ends the turn as interrupted.
 */
const FAKE_CLAUDE = String.raw`
const readline = require('node:readline')
if (process.env.VALET_TEST_ARGV) require('node:fs').writeFileSync(process.env.VALET_TEST_ARGV, JSON.stringify(process.argv.slice(2)))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const rl = readline.createInterface({ input: process.stdin })
let turn = 0
let interrupted = false
const S = { session_id: 'sess-1' }
out({ type: 'system', subtype: 'init', ...S, model: 'opus', permissionMode: 'bypassPermissions' })
out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1800000000 } } } })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
    interrupted = true
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } })
    out({ type: 'result', subtype: 'success', is_error: false, result: '', terminal_reason: 'interrupted', total_cost_usd: 0.03, usage: { input_tokens: 5, output_tokens: 1 }, ...S })
    return
  }
  if (msg.type === 'control_response') {
    const allowed = msg.response.response.behavior === 'allow'
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: allowed ? 'ok' : 'denied', is_error: !allowed }] }, parent_tool_use_id: null, ...S })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.02, usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 2 }, modelUsage: { opus: { contextWindow: 200000 } }, ...S })
    return
  }
  if (msg.type !== 'user') return
  turn++
  out({ type: 'user', message: msg.message, parent_tool_use_id: null, isReplay: true, ...S })
  if (turn === 1) {
    const ev = (event) => out({ type: 'stream_event', event, parent_tool_use_id: null, ...S })
    ev({ type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 3 } } })
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } })
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } })
    ev({ type: 'content_block_stop', index: 0 })
    out({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello' }] }, parent_tool_use_id: null, ...S })
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } })
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } })
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } })
    ev({ type: 'content_block_stop', index: 1 })
    out({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }, parent_tool_use_id: null, ...S })
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 7, cache_creation_input_tokens: 3 } })
    ev({ type: 'message_stop' })
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md\n' }] }, parent_tool_use_id: null, ...S })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello', total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 3 }, modelUsage: { opus: { contextWindow: 200000 } }, ...S })
    return
  }
  if (turn === 2) {
    out({ type: 'control_request', request_id: 'req_1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'a.txt', content: 'x' }, tool_use_id: 'toolu_2', description: 'Write a.txt' }, ...S })
    return
  }
  if (turn === 3) {
    // Stay busy until interrupted.
    return
  }
  if (turn === 4) {
    process.exit(2)
  }
})
rl.on('close', () => process.exit(0))
`

let cli: { dir: string; exe: string }
before(async () => {
  cli = await fakeCli('claude', FAKE_CLAUDE)
})
after(async () => {
  await fs.rm(cli.dir, { recursive: true, force: true })
})

const startOptions = (rec: ReturnType<typeof recorder>) => ({
  runner: new LocalRunner(),
  cwd: cli.dir,
  model: 'opus',
  permissions: 'ask' as const,
  env: { PATH: process.env.PATH ?? '' },
  resumeSessionId: null,
  mcpConfigPath: null,
  systemPromptSuffix: 'test',
  ...rec,
})

test('claude: valet mcp config is the only server source', async (t) => {
  const argvFile = path.join(cli.dir, 'argv.json')
  const rec = recorder()
  const adapter = new ClaudeAdapter(cli.exe)
  t.after(() => adapter.stop())
  await adapter.start({
    ...startOptions(rec),
    mcpConfigPath: '/home/valet/.valet/mcp.json',
    env: { PATH: process.env.PATH ?? '', VALET_TEST_ARGV: argvFile },
  })
  await adapter.sendTurn('t1', 'hi', [], 'queue')
  await rec.waitFor('turn.end')
  await adapter.stop()

  const argv = JSON.parse(await fs.readFile(argvFile, 'utf8')) as string[]
  assert.equal(argv[argv.indexOf('--mcp-config') + 1], '/home/valet/.valet/mcp.json')
  // Without this the CLI also loads the repository's .mcp.json, user scope and connectors.
  assert.ok(argv.includes('--strict-mcp-config'))
})

test('claude: text deltas, tool start/input/output, usage, turn.end', async (t) => {
  const rec = recorder()
  const adapter = new ClaudeAdapter(cli.exe)
  t.after(() => adapter.stop())
  await adapter.start(startOptions(rec))
  await adapter.sendTurn('t1', 'hi', [], 'queue')
  await rec.waitFor('turn.end')
  await adapter.stop()

  assert.deepEqual(rec.sessionIds, ['sess-1'])
  assert.deepEqual(types(rec.events), [
    'text.delta',
    'text.delta',
    'text.end',
    'tool.start',
    'tool.input',
    'tool.output',
    'usage',
    'turn.end',
  ])
  const [d1, , textEnd, toolStart, toolInput, toolOutput, usage, end] = rec.events as [
    Extract<ThreadEvent, { type: 'text.delta' }>,
    unknown,
    Extract<ThreadEvent, { type: 'text.end' }>,
    Extract<ThreadEvent, { type: 'tool.start' }>,
    Extract<ThreadEvent, { type: 'tool.input' }>,
    Extract<ThreadEvent, { type: 'tool.output' }>,
    Extract<ThreadEvent, { type: 'usage' }>,
    Extract<ThreadEvent, { type: 'turn.end' }>,
  ]
  assert.equal(d1.delta, 'Hel')
  assert.equal(textEnd.text, 'Hello')
  assert.equal(textEnd.itemId, d1.itemId)
  assert.equal(toolStart.name, 'bash')
  assert.equal(toolStart.vendorName, 'Bash')
  assert.equal(toolStart.itemId, 'toolu_1')
  assert.deepEqual(toolStart.input, {})
  assert.equal(toolInput.title, '$ ls')
  assert.deepEqual(toolInput.input, { command: 'ls' })
  assert.equal(toolOutput.output, 'README.md\n')
  assert.equal(toolOutput.isError, false)
  assert.equal(usage.rateLimits?.[0]?.window, 'five_hour')
  assert.equal(usage.rateLimits?.[0]?.utilization, 0.25)
  assert.equal(end.status, 'completed')
  assert.equal(end.turnId, 't1')
  assert.deepEqual(end.usage, {
    inputTokens: 10,
    outputTokens: 7,
    cachedInputTokens: 0,
    costUsd: 0.01,
    contextWindow: 200000,
    contextUsed: 20,
  })
  assert.equal(adapter.busy, false)
})

test('claude: permission request, allow, response, cumulative cost delta', async (t) => {
  const rec = recorder()
  const adapter = new ClaudeAdapter(cli.exe)
  t.after(() => adapter.stop())
  await adapter.start(startOptions(rec))
  await adapter.sendTurn('t1', 'first', [], 'queue')
  await rec.waitFor('turn.end')
  await adapter.sendTurn('t2', 'second', [], 'queue')
  await rec.waitFor('permission.request')

  const req = rec.events.find((e) => e.type === 'permission.request') as Extract<ThreadEvent, { type: 'permission.request' }>
  assert.equal(req.toolName, 'write')
  assert.equal(req.itemId, 'toolu_2')
  assert.equal(req.description, 'Write a.txt')
  assert.equal(req.turnId, 't2')
  await assert.rejects(adapter.sendTurn('t3', 'nope', [], 'queue'), /already in progress/)

  await adapter.answerPermission(req.requestId, 'allow')
  await rec.waitFor('turn.end', 2)
  await adapter.stop()

  const t2 = rec.events.filter((e) => 'turnId' in e && e.turnId === 't2')
  assert.deepEqual(types(t2), ['permission.request', 'permission.response', 'tool.output', 'usage', 'turn.end'])
  const end = t2[t2.length - 1] as Extract<ThreadEvent, { type: 'turn.end' }>
  assert.equal(end.status, 'completed')
  // total_cost_usd is cumulative per process: 0.02 - 0.01
  assert.ok(Math.abs((end.usage?.costUsd ?? 0) - 0.01) < 1e-9)
})

test('claude: interrupt ends the turn as interrupted', async (t) => {
  const rec = recorder()
  const adapter = new ClaudeAdapter(cli.exe)
  t.after(() => adapter.stop())
  await adapter.start(startOptions(rec))
  await adapter.sendTurn('t1', 'a', [], 'queue')
  await rec.waitFor('turn.end')
  await adapter.sendTurn('t2', 'b', [], 'queue')
  await rec.waitFor('permission.request')
  const req = rec.events.find((e) => e.type === 'permission.request') as Extract<ThreadEvent, { type: 'permission.request' }>
  await adapter.answerPermission(req.requestId, 'deny')
  await rec.waitFor('turn.end', 2)
  await adapter.sendTurn('t3', 'c', [], 'queue')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(adapter.busy, true)
  await adapter.interrupt()
  await rec.waitFor('turn.end', 3)
  await adapter.stop()

  const t2 = rec.events.filter((e) => 'turnId' in e && e.turnId === 't2')
  const denied = t2.find((e) => e.type === 'tool.output') as Extract<ThreadEvent, { type: 'tool.output' }>
  assert.equal(denied.isError, true)
  const t3end = rec.events.filter((e) => e.type === 'turn.end')[2] as Extract<ThreadEvent, { type: 'turn.end' }>
  assert.equal(t3end.turnId, 't3')
  assert.equal(t3end.status, 'interrupted')
})

test('claude: process crash mid-turn fails the turn and reports exit', async (t) => {
  const rec = recorder()
  const adapter = new ClaudeAdapter(cli.exe)
  t.after(() => adapter.stop())
  await adapter.start(startOptions(rec))
  for (const [id, text] of [
    ['t1', 'a'],
    ['t2', 'b'],
  ] as const) {
    await adapter.sendTurn(id, text, [], 'queue')
    if (id === 't2') {
      await rec.waitFor('permission.request')
      const req = rec.events.find((e) => e.type === 'permission.request') as Extract<ThreadEvent, { type: 'permission.request' }>
      await adapter.answerPermission(req.requestId, 'allow')
    }
    await rec.waitFor('turn.end', id === 't1' ? 1 : 2)
  }
  await adapter.sendTurn('t3', 'c', [], 'queue')
  await new Promise((r) => setTimeout(r, 50))
  await adapter.interrupt()
  await rec.waitFor('turn.end', 3)
  await adapter.sendTurn('t4', 'crash', [], 'queue')
  await rec.waitFor('turn.end', 4)

  const last = rec.events[rec.events.length - 1] as Extract<ThreadEvent, { type: 'turn.end' }>
  assert.equal(last.type, 'turn.end')
  assert.equal(last.status, 'failed')
  assert.match(last.error ?? '', /exited \(code 2/)
  assert.equal(adapter.started, false)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(rec.exits, [{ code: 2, signal: null, duringTurn: true }])
})
