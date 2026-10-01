import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { after, before, test } from 'node:test'
import type { ThreadEvent } from '@valet/shared'
import { CodexAdapter } from '../src/agents/codex.js'
import { LocalRunner } from '../src/agents/local-runner.js'
import { fakeCli, recorder, types } from './helpers.js'

/** Fake `codex app-server`: JSON-RPC over stdio without a jsonrpc field. */
const FAKE_CODEX = String.raw`
const readline = require('node:readline')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const rl = readline.createInterface({ input: process.stdin })
let turnCount = 0
let serverReq = 100
const T = 'thread-1'
out({ method: 'remoteControl/status/changed', params: { enabled: false } })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') return out({ id: msg.id, result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' } })
  if (msg.method === 'initialized') return
  if (msg.method === 'thread/resume') return out({ id: msg.id, error: { code: -32600, message: 'no such thread' } })
  if (msg.method === 'thread/start') return out({ id: msg.id, result: { thread: { id: T, model: msg.params.model, cwd: msg.params.cwd, preview: '' }, model: msg.params.model } })
  if (msg.method === 'turn/interrupt') {
    out({ id: msg.id, result: {} })
    out({ method: 'turn/completed', params: { threadId: T, turn: { id: msg.params.turnId, status: 'interrupted', error: null } } })
    return
  }
  if (msg.method === 'turn/steer') {
    out({ id: msg.id, result: {} })
    out({ method: 'item/agentMessage/delta', params: { threadId: T, turnId: msg.params.expectedTurnId, itemId: 'm2', delta: 'steered' } })
    out({ method: 'item/completed', params: { threadId: T, turnId: msg.params.expectedTurnId, item: { type: 'agentMessage', id: 'm2', text: 'steered' } } })
    out({ method: 'turn/completed', params: { threadId: T, turn: { id: msg.params.expectedTurnId, status: 'completed', error: null } } })
    return
  }
  if (msg.method === 'turn/start') {
    turnCount++
    const turnId = 'ct' + turnCount
    out({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress', error: null } } })
    out({ method: 'turn/started', params: { threadId: T, turn: { id: turnId, status: 'inProgress', error: null } } })
    const n = (method, params) => out({ method, params: { threadId: T, turnId, ...params } })
    if (turnCount === 1) {
      n('item/started', { item: { type: 'reasoning', id: 'r1', summary: [], content: [] } })
      n('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'thinking', summaryIndex: 0 })
      n('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['thinking'], content: [] } })
      n('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/repo', status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null } })
      n('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'a.txt\n' })
      n('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'b.txt\n' })
      n('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/repo', status: 'completed', aggregatedOutput: 'a.txt\nb.txt\n', exitCode: 0, durationMs: 5 } })
      n('item/started', { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'a.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@' }], status: 'inProgress' } })
      n('item/completed', { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'a.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@' }], status: 'completed' } })
      n('item/started', { item: { type: 'agentMessage', id: 'm1', text: '' } })
      n('item/agentMessage/delta', { itemId: 'm1', delta: 'All ' })
      n('item/agentMessage/delta', { itemId: 'm1', delta: 'done' })
      n('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'All done' } })
      out({ method: 'thread/tokenUsage/updated', params: { threadId: T, turnId, tokenUsage: { total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 50, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 }, last: { totalTokens: 60, inputTokens: 50, cachedInputTokens: 25, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2 }, modelContextWindow: 400000 } } })
      out({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: null } } } })
      out({ method: 'turn/completed', params: { threadId: T, turn: { id: turnId, status: 'completed', error: null } } })
    } else if (turnCount === 2) {
      const id = ++serverReq
      out({ id, method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: T, turnId, itemId: 'c2', startedAtMs: 0, environmentId: null, command: 'rm -rf build', cwd: '/repo', reason: 'cleanup' } })
      pendingApproval = { id, turnId }
    } else if (turnCount === 3) {
      const id = ++serverReq
      out({ id, method: 'item/tool/requestUserInput', params: { threadId: T, turnId, itemId: 'q1', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'color', header: 'Theme', question: 'Which color?', isOther: false, isSecret: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] } })
      pendingQuestion = { id, turnId }
    } else if (turnCount === 4 || turnCount === 5) {
      // Stays busy: steer or interrupt decides how it ends.
    } else if (turnCount === 6) {
      out({ method: 'error', params: { threadId: T, turnId, willRetry: false, error: { message: 'unauthorized', codexErrorInfo: null, additionalDetails: null, misalignment: null } } })
      out({ method: 'turn/completed', params: { threadId: T, turn: { id: turnId, status: 'failed', error: { message: 'unauthorized' } } } })
    }
    return
  }
  // Responses to server requests.
  if (msg.id !== undefined && msg.method === undefined) {
    if (pendingApproval && msg.id === pendingApproval.id) {
      const accepted = msg.result && msg.result.decision === 'accept'
      out({ method: 'item/completed', params: { threadId: T, turnId: pendingApproval.turnId, item: { type: 'commandExecution', id: 'c2', command: 'rm -rf build', cwd: '/repo', status: accepted ? 'completed' : 'declined', aggregatedOutput: accepted ? '' : null, exitCode: accepted ? 0 : null, durationMs: 1 } } })
      out({ method: 'turn/completed', params: { threadId: T, turn: { id: pendingApproval.turnId, status: 'completed', error: null } } })
      pendingApproval = null
    } else if (pendingQuestion && msg.id === pendingQuestion.id) {
      const answer = msg.result.answers.color.answers[0]
      out({ method: 'item/completed', params: { threadId: T, turnId: pendingQuestion.turnId, item: { type: 'agentMessage', id: 'm3', text: 'You picked ' + answer } } })
      out({ method: 'turn/completed', params: { threadId: T, turn: { id: pendingQuestion.turnId, status: 'completed', error: null } } })
      pendingQuestion = null
    }
  }
})
let pendingApproval = null
let pendingQuestion = null
rl.on('close', () => process.exit(0))
`

let cli: { dir: string; exe: string }
before(async () => {
  cli = await fakeCli('codex', FAKE_CODEX)
})
after(async () => {
  await fs.rm(cli.dir, { recursive: true, force: true })
})

function startOptions(rec: ReturnType<typeof recorder>, extra: Partial<Parameters<CodexAdapter['start']>[0]> = {}) {
  return {
    runner: new LocalRunner(),
    cwd: cli.dir,
    model: 'gpt-6-astra',
    permissions: 'on-request',
    env: { PATH: process.env.PATH ?? '' },
    resumeSessionId: null,
    mcpConfigPath: null,
    allowProjectMcp: false,
    systemPromptSuffix: 'test',
    ...rec,
    ...extra,
  }
}

const ev = <T extends ThreadEvent['type']>(events: ThreadEvent[], type: T, n = 0): Extract<ThreadEvent, { type: T }> =>
  events.filter((e) => e.type === type)[n] as Extract<ThreadEvent, { type: T }>

test('codex: handshake, items, deltas, usage, turn.end', async (t) => {
  const rec = recorder()
  const adapter = new CodexAdapter(cli.exe)
  t.after(() => adapter.stop())
  await adapter.start(startOptions(rec, { resumeSessionId: 'stale-thread' }))
  assert.deepEqual(rec.sessionIds, ['thread-1'])
  assert.equal(typeof adapter.pid, 'number')
  await adapter.sendTurn('t1', 'hello', [{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }], 'queue')
  await rec.waitFor('turn.end')
  await adapter.stop()
  assert.equal(adapter.pid, null)

  assert.deepEqual(types(rec.events), [
    'reasoning.delta',
    'reasoning.end',
    'tool.start',
    'tool.outputDelta',
    'tool.outputDelta',
    'tool.output',
    'tool.start',
    'tool.output',
    'text.delta',
    'text.delta',
    'text.end',
    'usage',
    'turn.end',
  ])
  assert.ok(rec.events.every((e) => !('turnId' in e) || e.turnId === 't1'))
  assert.equal(ev(rec.events, 'reasoning.end').text, 'thinking')
  const bash = ev(rec.events, 'tool.start', 0)
  assert.equal(bash.name, 'bash')
  assert.equal(bash.title, '$ ls -la')
  assert.deepEqual(bash.input, { command: 'ls -la', cwd: '/repo' })
  const bashOut = ev(rec.events, 'tool.output', 0)
  assert.equal(bashOut.exitCode, 0)
  assert.equal(bashOut.output, 'a.txt\nb.txt\n')
  const edit = ev(rec.events, 'tool.start', 1)
  assert.equal(edit.name, 'edit')
  assert.equal(edit.title, 'Edited a.txt')
  const editOut = ev(rec.events, 'tool.output', 1)
  assert.deepEqual(editOut.fileChanges, [{ path: 'a.txt', kind: 'update', diff: '@@ -1 +1 @@' }])
  assert.equal(ev(rec.events, 'text.end').text, 'All done')
  const usage = ev(rec.events, 'usage')
  assert.deepEqual(usage.rateLimits, [
    { window: 'five_hour', utilization: 0.125, resetsAt: new Date(1800000000 * 1000).toISOString() },
    { window: 'seven_day', utilization: 0.03, resetsAt: null },
  ])
  const end = ev(rec.events, 'turn.end')
  assert.equal(end.status, 'completed')
  assert.deepEqual(end.usage, { inputTokens: 50, outputTokens: 10, cachedInputTokens: 25, contextUsed: 60, contextWindow: 400000 })
})

test('codex: approval request and decision, user input question', async (t) => {
  const rec = recorder()
  const adapter = new CodexAdapter(cli.exe)
  t.after(() => adapter.stop())
  await adapter.start(startOptions(rec))
  await adapter.sendTurn('t1', 'one', [], 'queue')
  await rec.waitFor('turn.end')

  await adapter.sendTurn('t2', 'two', [], 'queue')
  await rec.waitFor('permission.request')
  const req = ev(rec.events, 'permission.request')
  assert.equal(req.turnId, 't2')
  assert.equal(req.toolName, 'bash')
  assert.equal(req.description, 'cleanup')
  assert.deepEqual(req.input, { command: 'rm -rf build', cwd: '/repo' })
  assert.equal(req.itemId, 'c2')
  await adapter.answerPermission(req.requestId, 'deny')
  await rec.waitFor('turn.end', 2)
  const t2 = rec.events.filter((e) => 'turnId' in e && e.turnId === 't2')
  assert.deepEqual(types(t2), ['permission.request', 'permission.response', 'tool.output', 'turn.end'])
  assert.equal((t2[2] as Extract<ThreadEvent, { type: 'tool.output' }>).isError, true)

  await adapter.sendTurn('t3', 'three', [], 'queue')
  await rec.waitFor('question.request')
  const q = ev(rec.events, 'question.request')
  assert.deepEqual(q.questions, [
    {
      id: 'color',
      question: 'Theme: Which color?',
      options: [
        { label: 'Red', description: 'warm' },
        { label: 'Blue', description: 'cool' },
      ],
      multiSelect: false,
    },
  ])
  await adapter.answerQuestion(q.requestId, { color: ['Blue'] })
  await rec.waitFor('turn.end', 3)
  await adapter.stop()
  const t3 = rec.events.filter((e) => 'turnId' in e && e.turnId === 't3')
  assert.deepEqual(types(t3), ['question.request', 'question.response', 'text.end', 'turn.end'])
  assert.equal((t3[2] as Extract<ThreadEvent, { type: 'text.end' }>).text, 'You picked Blue')
})

test('codex: steer joins the running turn; interrupt ends it', async (t) => {
  const rec = recorder()
  const adapter = new CodexAdapter(cli.exe)
  t.after(() => adapter.stop())
  await adapter.start(startOptions(rec))
  for (const [id, n] of [
    ['t1', 1],
    ['t2', 2],
    ['t3', 3],
  ] as const) {
    await adapter.sendTurn(id, id, [], 'queue')
    if (n === 2) {
      await rec.waitFor('permission.request')
      await adapter.answerPermission(ev(rec.events, 'permission.request').requestId, 'allow')
    }
    if (n === 3) {
      await rec.waitFor('question.request')
      await adapter.answerQuestion(ev(rec.events, 'question.request').requestId, { color: ['Red'] })
    }
    await rec.waitFor('turn.end', n)
  }
  await adapter.sendTurn('t4', 'four', [], 'queue')
  assert.equal(adapter.busy, true)
  await assert.rejects(adapter.sendTurn('t5', 'five', [], 'queue'), /already in progress/)
  await adapter.sendTurn('t4s', 'more', [], 'steer')
  await rec.waitFor('turn.end', 4)
  const t4 = rec.events.filter((e) => 'turnId' in e && e.turnId === 't4')
  assert.deepEqual(types(t4), ['text.delta', 'text.end', 'turn.end'])
  assert.equal(adapter.busy, false)

  await adapter.sendTurn('t6', 'six', [], 'queue')
  await adapter.interrupt()
  await rec.waitFor('turn.end', 5)
  assert.equal(ev(rec.events, 'turn.end', 4).status, 'interrupted')
  assert.equal(ev(rec.events, 'turn.end', 4).turnId, 't6')

  await adapter.sendTurn('t7', 'seven', [], 'queue')
  await rec.waitFor('turn.end', 6)
  await adapter.stop()
  const end = ev(rec.events, 'turn.end', 5)
  assert.equal(end.status, 'failed')
  assert.equal(end.error, 'unauthorized')
  assert.equal(ev(rec.events, 'error').message, 'unauthorized')
})
