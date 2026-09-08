// Fake core for UI work: `npm run mock -w @valet/web` (port 8081), then `VALET_CORE_URL=http://localhost:8081 npx next dev --webpack -p 3100` in apps/web.
// Set MOCK_PASSWORD to require a login (the password is the value); the cookie check only applies to /api/auth/session.
// Set MOCK_DOCKER_DOWN=1 to report Docker as unreachable in /api/health.

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT ?? 8081)
const PASSWORD = process.env.MOCK_PASSWORD ?? ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const projects = new Map(
  [
    {
      id: 'p-valet',
      name: 'valet',
      source: 'github',
      repoUrl: 'https://github.com/acme/valet',
      defaultBranch: 'main',
      hasSetupScript: true,
      createdAt: ago(60 * 24 * 12),
      updatedAt: ago(60 * 5),
    },
    {
      id: 'p-docs',
      name: 'docs-site',
      source: 'github',
      repoUrl: 'https://github.com/acme/docs-site',
      defaultBranch: 'develop',
      hasSetupScript: false,
      createdAt: ago(60 * 24 * 40),
      updatedAt: ago(60 * 24 * 2),
    },
    {
      id: 'p-scratch',
      name: 'scratch',
      source: 'blank',
      repoUrl: null,
      defaultBranch: 'main',
      hasSetupScript: null,
      createdAt: ago(60 * 24 * 3),
      updatedAt: ago(60 * 24 * 3),
    },
  ].map((p) => [p.id, p]),
)

const envVars = new Map([
  [
    'p-valet',
    [
      { name: 'DATABASE_URL', value: 'postgres://valet:secret@db:5432/valet', kind: 'secret' },
      { name: 'NODE_ENV', value: 'development', kind: 'plain' },
    ],
  ],
  ['p-docs', []],
  ['p-scratch', []],
])

function thread(overrides) {
  return {
    id: randomUUID(),
    projectId: 'p-valet',
    title: 'Untitled',
    agent: 'claude',
    model: 'opus',
    permissions: 'auto',
    status: 'idle',
    error: null,
    branch: 'valet/untitled-0000',
    baseBranch: 'main',
    containerId: 'c0ffee',
    agentSessionId: null,
    pr: null,
    costUsd: null,
    lastActivityAt: now(),
    createdAt: now(),
    archivedAt: null,
    ...overrides,
  }
}

/** @type {Map<string, {row: object, events: Array<{seq:number,event:object}>, subscribers: Set<import('ws').WebSocket>, services: object[], portals: object[]}>} */
const threads = new Map()

function addThread(row, events = []) {
  threads.set(row.id, { row, events: [], subscribers: new Set(), services: [], portals: [] })
  for (const e of events) appendEvent(row.id, e, { silent: true })
  return row
}

const portalUrl = (threadId, port) => `http://t-${threadId.replace(/[^a-z0-9]/g, '')}-p${port}.localhost:3100`

/** A managed service as the sandbox supervisor would report it. */
function service(threadId, overrides) {
  const name = overrides.name
  const port = overrides.port ?? null
  return {
    name,
    command: 'npm run dev',
    cwd: '/home/valet/workspace/repo',
    port,
    url: port === null ? null : portalUrl(threadId, port),
    portal: port === null ? false : { path: '/', title: name },
    health: null,
    source: 'adhoc',
    state: 'running',
    pid: 4242,
    uptimeSeconds: 754,
    restarts: 0,
    lastExitCode: null,
    updatedAt: ago(12),
    ...overrides,
  }
}

function publishServices(id) {
  const t = threads.get(id)
  if (t) broadcast(t.subscribers, { t: 'services', services: t.services })
}

const credentials = {
  claude: { kind: 'claude', configured: true, label: 'sk-ant-oat…3f9a', method: 'oauth', updatedAt: ago(60 * 24 * 3) },
  codex: { kind: 'codex', configured: false, label: null, method: null, updatedAt: null },
  github: { kind: 'github', configured: true, label: 'ghp_…a1b2 (natey)', method: null, updatedAt: ago(60 * 24 * 9) },
}

const settings = {
  idlePauseMinutes: 10,
  defaultAgent: 'claude',
  defaultModel: { claude: 'opus', codex: 'gpt-6-astra' },
  defaultPermissions: 'auto',
}

// The mock has no push service, so browsers subscribe against this fixed public key
// and no notification ever arrives; subscriptions are only counted.
const notifications = {
  vapidPublicKey: 'BK5TZgtSkbf6J6rxGHFPxV6Rgc35Ec7rv7hXSqtSrQdMkEj0b9OnuBKomLPX7pJRwg5zSNSoamZ7cFD50nSPULg',
  browsers: 1,
  webhooks: [
    { id: 'w-slack', kind: 'slack', url: 'https://hooks.slack.com/services/T000/B000/xxxx', hasSecret: false, events: ['waiting', 'error'] },
    { id: 'w-generic', kind: 'generic', url: 'https://example.com/hook', hasSecret: true, events: ['waiting', 'finished', 'error'] },
  ],
}

const MODELS = {
  claude: [
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
  ],
  codex: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ],
}

const repos = [
  { fullName: 'acme/valet', url: 'https://github.com/acme/valet', defaultBranch: 'main', private: true, description: 'Cloud agents', pushedAt: ago(30) },
  { fullName: 'acme/docs-site', url: 'https://github.com/acme/docs-site', defaultBranch: 'develop', private: false, description: null, pushedAt: ago(60 * 26) },
  { fullName: 'acme/billing', url: 'https://github.com/acme/billing', defaultBranch: 'main', private: true, description: 'Invoices', pushedAt: ago(60 * 24 * 6) },
  { fullName: 'natey/dotfiles', url: 'https://github.com/natey/dotfiles', defaultBranch: 'master', private: false, description: null, pushedAt: ago(60 * 24 * 90) },
]

const deviceLogins = new Map()

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const globalSubscribers = new Set()

function broadcast(set, frame) {
  const data = JSON.stringify(frame)
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data)
}

function listItem(row) {
  const t = threads.get(row.id)
  return {
    ...row,
    projectName: projects.get(row.projectId)?.name ?? 'Unknown',
    diffStats: t?.diffStats ?? null,
  }
}

function touch(id, patch = {}) {
  const t = threads.get(id)
  if (!t) return
  Object.assign(t.row, patch, { lastActivityAt: now() })
  broadcast(t.subscribers, { t: 'thread', thread: t.row })
  broadcast(globalSubscribers, { t: 'thread', thread: listItem(t.row) })
}

function appendEvent(id, event, { silent = false } = {}) {
  const t = threads.get(id)
  if (!t) return
  const seq = t.events.length + 1
  t.events.push({ seq, event })
  if (!silent) broadcast(t.subscribers, { t: 'event', seq, event })
  if (event.type === 'status') {
    const patch = { status: event.status }
    if (event.status !== 'error') patch.error = null
    if (silent) Object.assign(t.row, patch)
    else touch(id, patch)
  } else if (!silent) {
    touch(id)
  }
}

const pendingPermissions = new Map()
const pendingQuestions = new Map()

function setStatus(id, status, detail = null) {
  appendEvent(id, { type: 'status', status, detail, at: now() })
}

async function stream(id, turnId, itemId, type, text, chunk = 12, delay = 30) {
  for (let i = 0; i < text.length; i += chunk) {
    if (!threads.has(id)) return
    appendEvent(id, { type: `${type}.delta`, turnId, itemId, delta: text.slice(i, i + chunk) })
    await sleep(delay)
  }
  appendEvent(id, { type: `${type}.end`, turnId, itemId, text })
}

const EDIT_DIFF = `diff --git a/apps/core/src/threads.ts b/apps/core/src/threads.ts
--- a/apps/core/src/threads.ts
+++ b/apps/core/src/threads.ts
@@ -12,5 +12,7 @@ export async function pauseIdle(db: Db, minutes: number) {
   const cutoff = Date.now() - minutes * 60_000
   for (const t of await db.threads.idle()) {
-    if (t.lastActivityAt < cutoff) await stop(t)
+    if (new Date(t.lastActivityAt).getTime() < cutoff) {
+      await stop(t)
+    }
   }
 }
`

async function provision(id) {
  setStatus(id, 'provisioning')
  const lines = [
    'Creating container valet-sandbox-7f3a',
    'Cloning https://github.com/acme/valet (main)',
    'Checked out valet/idle-timer-fix-7f3a',
    'Running .valet/setup',
    'bun install v1.3.2: 412 packages installed [1.2s]',
  ]
  for (const message of lines) {
    if (!threads.has(id)) return
    appendEvent(id, { type: 'log', level: 'info', message, at: now() })
    await sleep(350)
  }
}

/** Scripted first turn: text, reasoning, tools (edit, failing bash), permission, question. */
async function runTurn(id, prompt, { mode = 'queue', full = true } = {}) {
  const t = threads.get(id)
  if (!t) return
  const turnId = `turn-${randomUUID().slice(0, 8)}`
  setStatus(id, 'running')
  appendEvent(id, { type: 'turn.start', turnId, prompt, mode, at: now() })
  t.currentTurn = turnId
  if (!t.row.agentSessionId) {
    const agentSessionId = randomUUID()
    appendEvent(id, { type: 'session', agentSessionId })
    touch(id, { agentSessionId })
  }
  const interrupted = () => t.interrupt === turnId

  await stream(
    id,
    turnId,
    'r1',
    'reasoning',
    'The idle timer compares an ISO string with a number, so the comparison is always false and nothing pauses. I should read the file, fix the comparison, and run the tests.',
    18,
    25,
  )
  if (interrupted()) return finish(id, turnId, 'interrupted')

  appendEvent(id, {
    type: 'tool.start',
    turnId,
    itemId: 't-read',
    name: 'read',
    vendorName: 'Read',
    input: { file_path: 'apps/core/src/threads.ts' },
    title: 'Read apps/core/src/threads.ts',
    parentItemId: null,
  })
  await sleep(400)
  appendEvent(id, {
    type: 'tool.output',
    turnId,
    itemId: 't-read',
    output: Array.from({ length: 40 }, (_, i) => `${i + 1}\texport const line${i + 1} = ${i + 1}`).join('\n'),
    isError: false,
    exitCode: null,
    fileChanges: null,
  })

  if (!full) {
    await stream(id, turnId, 'x1', 'text', `Done. ${prompt.text.slice(0, 40)}`)
    return finish(id, turnId, 'completed')
  }

  appendEvent(id, {
    type: 'tool.start',
    turnId,
    itemId: 't-edit',
    name: 'edit',
    vendorName: 'Edit',
    input: {
      file_path: 'apps/core/src/threads.ts',
      old_string: '    if (t.lastActivityAt < cutoff) await stop(t)',
      new_string: '    if (new Date(t.lastActivityAt).getTime() < cutoff) {\n      await stop(t)\n    }',
    },
    title: 'Edited apps/core/src/threads.ts',
    parentItemId: null,
  })
  await sleep(500)
  appendEvent(id, {
    type: 'tool.output',
    turnId,
    itemId: 't-edit',
    output: 'The file apps/core/src/threads.ts has been updated.',
    isError: false,
    exitCode: null,
    fileChanges: [{ path: 'apps/core/src/threads.ts', kind: 'update', diff: EDIT_DIFF }],
  })
  t.diffStats = { files: 1, additions: 3, deletions: 1 }
  touch(id)

  appendEvent(id, {
    type: 'tool.start',
    turnId,
    itemId: 't-bash-1',
    name: 'bash',
    vendorName: 'Bash',
    input: { command: 'npm run typecheck -w @valet/core' },
    title: '$ npm run typecheck -w @valet/core',
    parentItemId: null,
  })
  for (const line of ['> tsc --noEmit\n', '\n', "src/threads.ts(14,11): error TS2367: This comparison appears to be unintentional because the types 'string' and 'number' have no overlap.\n"]) {
    await sleep(300)
    appendEvent(id, { type: 'tool.outputDelta', turnId, itemId: 't-bash-1', delta: line })
  }
  appendEvent(id, {
    type: 'tool.output',
    turnId,
    itemId: 't-bash-1',
    output: "> tsc --noEmit\n\nsrc/threads.ts(14,11): error TS2367: This comparison appears to be unintentional because the types 'string' and 'number' have no overlap.\n\x1b[31mnpm error\x1b[0m Lifecycle script `typecheck` failed with error code 2",
    isError: true,
    exitCode: 2,
    fileChanges: null,
  })
  if (interrupted()) return finish(id, turnId, 'interrupted')

  appendEvent(id, {
    type: 'tool.start',
    turnId,
    itemId: 't-edit-2',
    name: 'edit',
    vendorName: 'Edit',
    input: { file_path: 'apps/core/src/threads.ts', old_string: 'const cutoff = Date.now() - minutes * 60_000', new_string: 'const cutoff = Date.now() - minutes * 60_000 // ms' },
    title: 'Edited apps/core/src/threads.ts',
    parentItemId: null,
  })
  await sleep(300)
  appendEvent(id, { type: 'tool.output', turnId, itemId: 't-edit-2', output: 'ok', isError: false, exitCode: null, fileChanges: null })

  await stream(id, turnId, 'x0', 'text', 'The comparison is fixed. Running the test suite needs approval in ask mode.')

  const requestId = `perm-${randomUUID().slice(0, 6)}`
  appendEvent(id, {
    type: 'permission.request',
    turnId,
    requestId,
    toolName: 'Bash',
    input: { command: 'npm test -w @valet/core' },
    description: 'Run the core test suite',
    itemId: null,
  })
  setStatus(id, 'waiting')
  const decision = await new Promise((resolve) => pendingPermissions.set(requestId, resolve))
  appendEvent(id, { type: 'permission.response', turnId, requestId, decision, by: 'user' })
  setStatus(id, 'running')
  if (interrupted()) return finish(id, turnId, 'interrupted')

  if (decision === 'allow') {
    appendEvent(id, {
      type: 'tool.start',
      turnId,
      itemId: 't-bash-2',
      name: 'bash',
      vendorName: 'Bash',
      input: { command: 'npm test -w @valet/core' },
      title: '$ npm test -w @valet/core',
      parentItemId: null,
    })
    let out = ''
    for (let i = 1; i <= 260; i++) {
      const line = i % 40 === 0 ? `\x1b[32m✓\x1b[0m suite ${i / 40} passed\n` : `  test ${i} ok\n`
      out += line
      if (i % 20 === 0) {
        appendEvent(id, { type: 'tool.outputDelta', turnId, itemId: 't-bash-2', delta: out.split('\n').slice(-20).join('\n') })
        await sleep(60)
      }
    }
    appendEvent(id, { type: 'tool.output', turnId, itemId: 't-bash-2', output: out + '\n260 passed', isError: false, exitCode: 0, fileChanges: null })
  } else {
    await stream(id, turnId, 'x-denied', 'text', 'Skipping the test run.')
  }

  const qid = `q-${randomUUID().slice(0, 6)}`
  appendEvent(id, {
    type: 'question.request',
    turnId,
    requestId: qid,
    itemId: null,
    questions: [
      {
        id: 'commit',
        question: 'Commit the fix now?',
        options: [
          { label: 'Commit', description: 'valet: fix idle timer comparison' },
          { label: 'Leave uncommitted', description: null },
        ],
        multiSelect: false,
      },
    ],
  })
  setStatus(id, 'waiting')
  const answers = await new Promise((resolve) => pendingQuestions.set(qid, resolve))
  appendEvent(id, { type: 'question.response', turnId, requestId: qid, answers })
  setStatus(id, 'running')

  await stream(
    id,
    turnId,
    'x2',
    'text',
    `## Summary\n\nFixed the idle timer in \`apps/core/src/threads.ts\`: \`lastActivityAt\` is an ISO string, so it is now parsed before comparing.\n\n\`\`\`ts\nif (new Date(t.lastActivityAt).getTime() < cutoff) {\n  await stop(t)\n}\n\`\`\`\n\n${answers.commit?.[0] === 'Commit' ? 'Committed as `valet: fix idle timer comparison`.' : 'Left the change uncommitted.'}`,
    10,
    20,
  )
  finish(id, turnId, 'completed')
}

function finish(id, turnId, status) {
  const t = threads.get(id)
  if (!t) return
  t.currentTurn = null
  t.interrupt = null
  const usage = { inputTokens: 48210, outputTokens: 3120, cachedInputTokens: 40100, costUsd: 0.42, contextWindow: 200000, contextUsed: 61200 }
  appendEvent(id, { type: 'usage', turnId, usage, rateLimits: [{ window: 'five_hour', utilization: 0.31, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] })
  appendEvent(id, { type: 'turn.end', turnId, status, error: status === 'failed' ? 'Agent exited unexpectedly' : null, usage, at: now() })
  touch(id, { costUsd: (t.row.costUsd ?? 0) + usage.costUsd })
  setStatus(id, 'idle')
}

async function startThread(row, prompt) {
  await provision(row.id)
  if (!threads.has(row.id)) return
  await runTurn(row.id, prompt)
}

// Seed threads across every status.
{
  const t1 = addThread(thread({ id: 't-idle', title: 'Fix the idle timer comparison', branch: 'valet/idle-timer-fix-7f3a', permissions: 'ask', costUsd: 0.42, lastActivityAt: ago(12), createdAt: ago(45) }))
  threads.get('t-idle').diffStats = { files: 3, additions: 42, deletions: 9 }
  threads.get('t-idle').services = [
    service('t-idle', { name: 'web', port: 30000, command: 'bun run dev --port $PORT', source: 'yaml', health: '/healthz', portal: { path: '/', title: 'Web' } }),
    service('t-idle', { name: 'api', port: 30001, command: 'uv run uvicorn app:app --port $PORT', state: 'starting', pid: 4310, uptimeSeconds: 1, restarts: 2 }),
    service('t-idle', { name: 'worker', command: 'bun run worker', state: 'failed', pid: null, uptimeSeconds: null, restarts: 10, lastExitCode: 1 }),
    service('t-idle', { name: 'docs', port: 30002, command: 'mkdocs serve -a 127.0.0.1:$PORT', state: 'stopped', pid: null, uptimeSeconds: null }),
  ]
  threads.get('t-idle').portals = [
    { port: 30000, name: 'web', process: 'bun', url: portalUrl('t-idle', 30000), shareExpiresAt: null },
    { port: 30001, name: 'api', process: 'python3', url: portalUrl('t-idle', 30001), shareExpiresAt: null },
    { port: 5555, name: null, process: 'node', url: portalUrl('t-idle', 5555), shareExpiresAt: null },
  ]
  // Complete transcript, built instantly.
  const seed = async () => {
    const id = t1.id
    const turnId = 'turn-seed'
    appendEvent(id, { type: 'log', level: 'info', message: 'Creating container valet-sandbox-7f3a', at: ago(45) }, { silent: true })
    appendEvent(id, { type: 'log', level: 'info', message: 'Cloning https://github.com/acme/valet (main)', at: ago(45) }, { silent: true })
    appendEvent(id, { type: 'status', status: 'running', detail: null, at: ago(44) }, { silent: true })
    appendEvent(id, { type: 'turn.start', turnId, prompt: { text: 'Fix the idle timer comparison in core; it never pauses containers.', images: [] }, mode: 'queue', at: ago(44) }, { silent: true })
    appendEvent(id, { type: 'reasoning.end', turnId, itemId: 'r1', text: 'The comparison mixes a string and a number.' }, { silent: true })
    appendEvent(id, { type: 'tool.start', turnId, itemId: 'a', name: 'read', vendorName: 'Read', input: { file_path: 'apps/core/src/threads.ts' }, title: 'Read apps/core/src/threads.ts', parentItemId: null }, { silent: true })
    appendEvent(id, { type: 'tool.output', turnId, itemId: 'a', output: 'export async function pauseIdle() {}', isError: false, exitCode: null, fileChanges: null }, { silent: true })
    appendEvent(id, { type: 'tool.start', turnId, itemId: 'b', name: 'read', vendorName: 'Read', input: { file_path: 'apps/core/src/db.ts' }, title: 'Read apps/core/src/db.ts', parentItemId: null }, { silent: true })
    appendEvent(id, { type: 'tool.output', turnId, itemId: 'b', output: 'export const db = {}', isError: false, exitCode: null, fileChanges: null }, { silent: true })
    appendEvent(id, { type: 'tool.start', turnId, itemId: 'c', name: 'edit', vendorName: 'Edit', input: { file_path: 'apps/core/src/threads.ts', old_string: 'a', new_string: 'b' }, title: 'Edited apps/core/src/threads.ts', parentItemId: null }, { silent: true })
    appendEvent(id, { type: 'tool.output', turnId, itemId: 'c', output: 'ok', isError: false, exitCode: null, fileChanges: [{ path: 'apps/core/src/threads.ts', kind: 'update', diff: EDIT_DIFF }] }, { silent: true })
    appendEvent(id, { type: 'text.end', turnId, itemId: 'x', text: 'Fixed the comparison and added a regression test.' }, { silent: true })
    appendEvent(id, { type: 'turn.end', turnId, status: 'completed', error: null, usage: { inputTokens: 30500, outputTokens: 1800, costUsd: 0.42 }, at: ago(40) }, { silent: true })
    appendEvent(id, { type: 'status', status: 'idle', detail: null, at: ago(40) }, { silent: true })
    t1.status = 'idle'
    t1.lastActivityAt = ago(12)
  }
  seed()

  addThread(thread({ id: 't-running', projectId: 'p-docs', title: 'Migrate docs build to Astro 6', branch: 'valet/astro-6-migration-1b2c', baseBranch: 'develop', agent: 'codex', model: 'gpt-6-astra', status: 'running', lastActivityAt: ago(1), createdAt: ago(20) }))
  threads.get('t-running').diffStats = { files: 12, additions: 318, deletions: 240 }
  addThread(thread({ id: 't-waiting', title: 'Add rate limit headers to the API', branch: 'valet/rate-limit-headers-9d1e', permissions: 'ask', status: 'waiting', lastActivityAt: ago(3), createdAt: ago(30), pr: { url: 'https://github.com/acme/valet/pull/412', number: 412, state: 'open' } }))
  addThread(thread({ id: 't-paused', title: 'Write release notes for 0.4', branch: 'valet/release-notes-0-4-77aa', status: 'paused', containerId: null, lastActivityAt: ago(60 * 3), createdAt: ago(60 * 5), costUsd: 1.13 }))
  threads.get('t-paused').diffStats = { files: 1, additions: 88, deletions: 0 }
  addThread(
    thread({ id: 't-error', projectId: 'p-scratch', title: 'Bootstrap a CLI in Go', branch: 'valet/bootstrap-cli-go-4e4e', status: 'error', error: 'Setup script exited with code 1', containerId: null, lastActivityAt: ago(60 * 26), createdAt: ago(60 * 27) }),
    [
      { type: 'log', level: 'info', message: 'Creating container valet-sandbox-4e4e', at: ago(60 * 27) },
      { type: 'log', level: 'info', message: 'Cloning file:///valet/repos/p-scratch.git', at: ago(60 * 27) },
      { type: 'log', level: 'info', message: 'Running .valet/setup', at: ago(60 * 27) },
      { type: 'log', level: 'error', message: 'go: command not found', at: ago(60 * 26) },
      { type: 'error', turnId: null, message: 'Setup script exited with code 1', at: ago(60 * 26) },
      { type: 'status', status: 'error', detail: 'Setup script exited with code 1', at: ago(60 * 26) },
    ],
  )
  addThread(thread({ id: 't-archived', title: 'Remove the legacy runner', branch: 'valet/remove-legacy-runner-c0de', status: 'archived', containerId: null, archivedAt: ago(60 * 24 * 4), lastActivityAt: ago(60 * 24 * 4), createdAt: ago(60 * 24 * 6), pr: { url: 'https://github.com/acme/valet/pull/398', number: 398, state: 'merged' }, costUsd: 3.9 }))

  // The running seed keeps producing output so the sidebar shows live activity.
  // It is a real current turn: steer attaches to it and interrupt ends it.
  ;(async () => {
    const id = 't-running'
    const turnId = 'turn-live'
    const t = threads.get(id)
    t.currentTurn = turnId
    appendEvent(id, { type: 'turn.start', turnId, prompt: { text: 'Migrate the docs build to Astro 6 and fix the broken sitemap.', images: [] }, mode: 'queue', at: ago(20) }, { silent: true })
    const active = () => threads.has(id) && t.row.status === 'running' && t.interrupt !== turnId
    let n = 0
    while (active()) {
      n += 1
      appendEvent(id, { type: 'tool.start', turnId, itemId: `live-${n}`, name: 'bash', vendorName: 'Bash', input: { command: `npm run build -- --page ${n}` }, title: `$ npm run build -- --page ${n}`, parentItemId: null })
      await sleep(4000)
      if (!active()) break
      appendEvent(id, { type: 'tool.output', turnId, itemId: `live-${n}`, output: `built page ${n}`, isError: false, exitCode: 0, fileChanges: null })
      await sleep(4000)
    }
    if (t.interrupt === turnId && threads.has(id)) finish(id, turnId, 'interrupted')
    else t.currentTurn = null
  })()
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status)
    res.end()
    return
  }
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

const fail = (res, status, error) => send(res, status, { error })

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function mask(value) {
  return value.length <= 4 ? '…' : `${value.slice(0, 3)}…${value.slice(-4)}`
}

const CHANGED_FILES = [
  { path: 'apps/core/src/threads.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, patch: EDIT_DIFF },
  {
    path: 'apps/core/src/threads.test.ts',
    oldPath: null,
    status: 'added',
    additions: 14,
    deletions: 0,
    patch: `diff --git a/apps/core/src/threads.test.ts b/apps/core/src/threads.test.ts
new file mode 100644
--- /dev/null
+++ b/apps/core/src/threads.test.ts
@@ -0,0 +1,14 @@
+import { describe, expect, it } from 'vitest'
+import { pauseIdle } from './threads.js'
+
+describe('pauseIdle', () => {
+  it('stops containers idle past the cutoff', async () => {
+    const stopped: string[] = []
+    const db = fakeDb([{ id: 'a', lastActivityAt: new Date(Date.now() - 20 * 60_000).toISOString() }])
+    await pauseIdle(db, 10, (t) => stopped.push(t.id))
+    expect(stopped).toEqual(['a'])
+  })
+  it('leaves recent threads alone', async () => {
+    expect(true).toBe(true)
+  })
+})
`,
  },
  {
    path: 'README.md',
    oldPath: 'docs/README.md',
    status: 'renamed',
    additions: 1,
    deletions: 1,
    patch: `diff --git a/docs/README.md b/README.md
similarity index 98%
rename from docs/README.md
rename to README.md
--- a/docs/README.md
+++ b/README.md
@@ -1,4 +1,4 @@
-# Valet docs
+# Valet

 Self-hosted cloud coding agents.
`,
  },
]

const FILE_TREE = {
  '': [
    { name: 'apps', path: 'apps', kind: 'dir', size: null },
    { name: 'packages', path: 'packages', kind: 'dir', size: null },
    { name: 'README.md', path: 'README.md', kind: 'file', size: 5144 },
    { name: 'package.json', path: 'package.json', kind: 'file', size: 830 },
    { name: 'logo.png', path: 'logo.png', kind: 'file', size: 48211 },
  ],
  apps: [
    { name: 'core', path: 'apps/core', kind: 'dir', size: null },
    { name: 'web', path: 'apps/web', kind: 'dir', size: null },
  ],
  'apps/core': [{ name: 'src', path: 'apps/core/src', kind: 'dir', size: null }],
  'apps/core/src': [
    { name: 'threads.ts', path: 'apps/core/src/threads.ts', kind: 'file', size: 1290 },
    { name: 'db.ts', path: 'apps/core/src/db.ts', kind: 'file', size: 400 },
  ],
  'apps/web': [],
  packages: [{ name: 'shared', path: 'packages/shared', kind: 'dir', size: null }],
  'packages/shared': [],
}

const FILES = {
  'README.md': '# Valet\n\nSelf-hosted cloud coding agents.\n\n## Install\n\n```sh\ndocker compose up -d\n```\n',
  'package.json': '{\n  "name": "valet",\n  "private": true,\n  "workspaces": ["packages/*", "apps/*"]\n}\n',
  'apps/core/src/threads.ts': `import type { Db, Thread } from './db.js'

export async function pauseIdle(db: Db, minutes: number, stop: (t: Thread) => Promise<void>) {
  const cutoff = Date.now() - minutes * 60_000 // ms
  for (const t of await db.threads.idle()) {
    if (new Date(t.lastActivityAt).getTime() < cutoff) {
      await stop(t)
    }
  }
}
`,
  'apps/core/src/db.ts': 'export type Thread = { id: string; lastActivityAt: string }\nexport type Db = { threads: { idle(): Promise<Thread[]> } }\n',
}

const LIVE = new Set(['running', 'waiting', 'idle'])

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const method = req.method
  const seg = path.split('/').filter(Boolean)
  const cookie = req.headers.cookie ?? ''
  await sleep(40)

  if (path === '/api/health') {
    return send(res, 200, {
      ok: true,
      version: '0.1.0-mock',
      db: { ok: true, error: null },
      docker: process.env.MOCK_DOCKER_DOWN
        ? { ok: false, error: 'connect ENOENT /var/run/docker.sock' }
        : { ok: true, error: null },
      sandboxImage: { image: 'valet-sandbox:latest', present: true, imageId: 'sha256:9f2a7c1d3e4b5a6f7081920a1b2c3d4e5f60718293a4b5c6d7e8f9', createdAt: ago(60 * 24) },
      authEnabled: PASSWORD !== '',
    })
  }
  if (path === '/api/auth/session') {
    return send(res, 200, { authenticated: !PASSWORD || cookie.includes('valet_session='), required: PASSWORD !== '' })
  }
  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req)
    if (PASSWORD && body.password !== PASSWORD) return fail(res, 401, 'Wrong password')
    res.writeHead(204, { 'set-cookie': 'valet_session=mock; Path=/; HttpOnly; SameSite=Lax' })
    return res.end()
  }

  if (path === '/api/settings') {
    if (method === 'PUT') Object.assign(settings, await readJson(req))
    return send(res, 200, settings)
  }
  if (path === '/api/agents') {
    return send(res, 200, {
      agents: ['claude', 'codex'].map((id) => ({
        id,
        label: id === 'claude' ? 'Claude Code' : 'Codex',
        available: credentials[id].configured,
        reason: credentials[id].configured ? null : 'Not configured',
        models: MODELS[id],
        defaultModel: MODELS[id][0].id,
      })),
    })
  }

  if (path === '/api/notifications') return send(res, 200, notifications)
  if (path === '/api/notifications/subscriptions') {
    if (method === 'POST') {
      notifications.browsers += 1
      return send(res, 204)
    }
    if (method === 'DELETE') {
      notifications.browsers = Math.max(0, notifications.browsers - 1)
      return send(res, 204)
    }
  }
  if (path === '/api/notifications/test' && method === 'POST') {
    await readJson(req)
    return send(res, 200, { ok: true, error: null })
  }
  if (path === '/api/notifications/webhooks' && method === 'PUT') {
    const body = await readJson(req)
    notifications.webhooks = body.webhooks.map((w, i) => ({
      id: w.id ?? `w-${i}-${randomUUID().slice(0, 8)}`,
      kind: w.kind,
      url: w.url,
      hasSecret: w.kind === 'generic' && (Boolean(w.secret) || (notifications.webhooks.find((o) => o.id === w.id)?.hasSecret ?? false)),
      events: w.events,
    }))
    return send(res, 200, notifications)
  }
  if (seg[0] === 'api' && seg[1] === 'notifications' && seg[2] === 'webhooks' && seg[4] === 'test' && method === 'POST') {
    const hook = notifications.webhooks.find((w) => w.id === seg[3])
    if (!hook) return fail(res, 404, 'webhook not found')
    return send(res, 200, { ok: true, error: null })
  }

  if (path === '/api/credentials') return send(res, 200, Object.values(credentials))
  if (path === '/api/credentials/codex/device-login' && method === 'POST') {
    const login = { id: randomUUID(), status: 'pending', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'HXKT-92QF', error: null, polls: 0 }
    deviceLogins.set(login.id, login)
    return send(res, 200, { ...login, polls: undefined })
  }
  if (seg[0] === 'api' && seg[1] === 'credentials' && seg[2] === 'codex' && seg[3] === 'device-login' && seg[4]) {
    const login = deviceLogins.get(seg[4])
    if (!login) return fail(res, 404, 'Not found')
    login.polls += 1
    if (login.polls >= 3 && login.status === 'pending') {
      login.status = 'complete'
      Object.assign(credentials.codex, { configured: true, label: 'ChatGPT (natey@example.com)', method: 'oauth', updatedAt: now() })
    }
    return send(res, 200, { ...login, polls: undefined })
  }
  if (path === '/api/credentials/github/repos') {
    if (!credentials.github.configured) return fail(res, 400, 'GitHub is not configured')
    const query = (url.searchParams.get('query') ?? '').toLowerCase()
    return send(res, 200, { repos: repos.filter((r) => r.fullName.toLowerCase().includes(query)) })
  }
  if (seg[0] === 'api' && seg[1] === 'credentials' && seg[2] === 'github' && seg[3] === 'repos' && seg[6] === 'branches') {
    const repo = repos.find((r) => r.fullName === `${seg[4]}/${seg[5]}`)
    const defaultBranch = repo?.defaultBranch ?? 'main'
    return send(res, 200, { branches: [defaultBranch, 'develop', 'release/0.4', 'feature/astro-6'].filter((b, i, a) => a.indexOf(b) === i), defaultBranch })
  }
  if (seg[0] === 'api' && seg[1] === 'credentials' && seg[2] in credentials) {
    const kind = seg[2]
    if (method === 'PUT') {
      const body = await readJson(req)
      const secret = body.token ?? body.apiKey ?? ''
      if (!secret) return fail(res, 400, 'Missing token')
      Object.assign(credentials[kind], {
        configured: true,
        label: kind === 'github' ? `${mask(secret)} (natey)` : mask(secret),
        method: kind === 'github' ? null : secret.startsWith('sk-ant-oat') ? 'oauth' : 'api-key',
        updatedAt: now(),
      })
      return send(res, 200, credentials[kind])
    }
    if (method === 'DELETE') {
      Object.assign(credentials[kind], { configured: false, label: null, method: null, updatedAt: null })
      return send(res, 204)
    }
  }

  if (path === '/api/projects') {
    if (method === 'POST') {
      const body = await readJson(req)
      const id = `p-${randomUUID().slice(0, 6)}`
      const project =
        body.source === 'github'
          ? { id, name: body.name ?? body.repoUrl.split('/').pop(), source: 'github', repoUrl: body.repoUrl, defaultBranch: body.defaultBranch ?? 'main', hasSetupScript: null, createdAt: now(), updatedAt: now() }
          : { id, name: body.name, source: 'blank', repoUrl: null, defaultBranch: 'main', hasSetupScript: null, createdAt: now(), updatedAt: now() }
      projects.set(id, project)
      envVars.set(id, [])
      broadcast(globalSubscribers, { t: 'project', project })
      return send(res, 200, project)
    }
    return send(res, 200, { projects: [...projects.values()] })
  }
  if (seg[0] === 'api' && seg[1] === 'projects' && seg[2]) {
    const project = projects.get(seg[2])
    if (!project) return fail(res, 404, 'Project not found')
    if (seg[3] === 'env') {
      if (method === 'PUT') {
        const body = await readJson(req)
        const existing = new Map((envVars.get(project.id) ?? []).map((v) => [v.name, v]))
        const next = body.vars.map((v) => ({ name: v.name, kind: v.kind, value: v.value ?? existing.get(v.name)?.value ?? '' }))
        envVars.set(project.id, next)
      }
      return send(res, 200, { vars: (envVars.get(project.id) ?? []).map((v) => ({ name: v.name, kind: v.kind, maskedValue: mask(v.value) })) })
    }
    if (method === 'PATCH') {
      Object.assign(project, await readJson(req), { updatedAt: now() })
      broadcast(globalSubscribers, { t: 'project', project })
      return send(res, 200, project)
    }
    if (method === 'DELETE') {
      const owned = [...threads.values()].filter((t) => t.row.projectId === project.id)
      if (owned.length > 0 && url.searchParams.get('force') !== '1') return fail(res, 409, `${owned.length} threads use this project`)
      for (const t of owned) {
        threads.delete(t.row.id)
        broadcast(globalSubscribers, { t: 'thread.deleted', id: t.row.id })
      }
      projects.delete(project.id)
      broadcast(globalSubscribers, { t: 'project.deleted', id: project.id })
      return send(res, 204)
    }
    return send(res, 200, project)
  }

  if (path === '/api/threads') {
    if (method === 'POST') {
      const body = await readJson(req)
      const project = projects.get(body.projectId)
      if (!project) return fail(res, 400, 'Unknown project')
      const title = body.prompt.split('\n')[0].slice(0, 60)
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'thread'
      const row = addThread(
        thread({
          projectId: project.id,
          title,
          agent: body.agent,
          model: body.model,
          permissions: body.permissions ?? 'auto',
          status: 'provisioning',
          branch: `valet/${slug}-${randomUUID().slice(0, 4)}`,
          baseBranch: body.baseBranch ?? project.defaultBranch,
          containerId: null,
        }),
      )
      broadcast(globalSubscribers, { t: 'thread', thread: listItem(row) })
      startThread(row, { text: body.prompt, images: body.images ?? [] })
      return send(res, 200, row)
    }
    const archived = url.searchParams.get('archived') === '1'
    const rows = [...threads.values()]
      .map((t) => t.row)
      .filter((r) => (r.status === 'archived') === archived)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    return send(res, 200, { threads: rows.map(listItem) })
  }

  if (seg[0] === 'api' && seg[1] === 'threads' && seg[2]) {
    const t = threads.get(seg[2])
    if (!t) return fail(res, 404, 'Thread not found')
    const id = t.row.id
    const action = seg[3]
    if (!action) {
      if (method === 'PATCH') {
        const body = await readJson(req)
        touch(id, { title: body.title ?? t.row.title })
        return send(res, 200, listItem(t.row))
      }
      if (method === 'DELETE') {
        threads.delete(id)
        for (const ws of t.subscribers) ws.close()
        broadcast(globalSubscribers, { t: 'thread.deleted', id })
        return send(res, 204)
      }
      return send(res, 200, listItem(t.row))
    }
    switch (action) {
      case 'messages': {
        const body = await readJson(req)
        if (t.row.status === 'archived') return fail(res, 409, 'Thread is archived')
        const prompt = { text: body.text, images: body.images ?? [] }
        if (body.mode === 'steer' && t.currentTurn) {
          appendEvent(id, { type: 'turn.start', turnId: `steer-${randomUUID().slice(0, 6)}`, prompt, mode: 'steer', at: now() })
          return send(res, 200, { turnId: t.currentTurn })
        }
        const turnId = `turn-${randomUUID().slice(0, 8)}`
        ;(async () => {
          if (t.currentTurn) {
            while (t.currentTurn) await sleep(200)
          }
          if (t.row.status === 'paused') {
            appendEvent(id, { type: 'log', level: 'info', message: 'Starting container', at: now() })
            await sleep(800)
          }
          if (t.row.status === 'error') {
            await provision(id)
          }
          await runTurn(id, prompt, { full: false })
        })()
        return send(res, 200, { turnId })
      }
      case 'interrupt':
        if (t.currentTurn) t.interrupt = t.currentTurn
        return send(res, 204)
      case 'pause':
        if (t.row.status === 'idle' || t.row.status === 'waiting') {
          setStatus(id, 'paused')
          touch(id, { containerId: null })
        }
        return send(res, 200, t.row)
      case 'wake':
        if (t.row.status === 'paused') {
          appendEvent(id, { type: 'log', level: 'info', message: 'Starting container', at: now() })
          setStatus(id, 'idle')
          touch(id, { containerId: 'c0ffee' })
        }
        return send(res, 200, t.row)
      case 'archive':
        setStatus(id, 'archived')
        touch(id, { archivedAt: now(), containerId: null })
        return send(res, 200, t.row)
      case 'unarchive':
        setStatus(id, 'paused')
        touch(id, { archivedAt: null })
        return send(res, 200, t.row)
      case 'permissions': {
        const body = await readJson(req)
        const resolve = pendingPermissions.get(seg[4])
        if (!resolve) return fail(res, 404, 'No pending permission')
        pendingPermissions.delete(seg[4])
        resolve(body.decision)
        return send(res, 204)
      }
      case 'questions': {
        const body = await readJson(req)
        const resolve = pendingQuestions.get(seg[4])
        if (!resolve) return fail(res, 404, 'No pending question')
        pendingQuestions.delete(seg[4])
        resolve(body.answers)
        return send(res, 204)
      }
      case 'events': {
        const since = Number(url.searchParams.get('since') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 500)
        const events = t.events.filter((e) => e.seq > since)
        return send(res, 200, { events: events.slice(0, limit), hasMore: events.length > limit })
      }
      case 'changes':
        if (t.row.status === 'paused') return fail(res, 409, 'paused')
        if (!LIVE.has(t.row.status)) return fail(res, 409, t.row.status)
        return send(res, 200, {
          stats: { files: CHANGED_FILES.length, additions: CHANGED_FILES.reduce((n, f) => n + f.additions, 0), deletions: CHANGED_FILES.reduce((n, f) => n + f.deletions, 0) },
          files: CHANGED_FILES,
          commits: [
            { sha: '9f2a7c1d3e4b5a6f7081920a1b2c3d4e5f607182', subject: 'valet: fix idle timer comparison', at: ago(8) },
            { sha: '1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4', subject: 'Add regression test for pauseIdle', at: ago(6) },
          ],
          dirty: true,
        })
      case 'files': {
        if (!LIVE.has(t.row.status)) return fail(res, 409, t.row.status)
        const dir = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '')
        const entries = FILE_TREE[dir]
        if (!entries) return fail(res, 404, 'No such directory')
        return send(res, 200, { path: dir, entries })
      }
      case 'file': {
        if (!LIVE.has(t.row.status)) return fail(res, 409, t.row.status)
        const p = (url.searchParams.get('path') ?? '').replace(/^\/+/, '')
        if (p === 'logo.png') return send(res, 200, { path: p, content: null, truncated: false, binary: true, size: 48211 })
        const content = FILES[p]
        if (content === undefined) return fail(res, 404, 'No such file')
        return send(res, 200, { path: p, content, truncated: p === 'README.md', binary: false, size: Buffer.byteLength(content) })
      }
      case 'portals':
        return send(res, 200, { portals: t.portals })
      case 'services': {
        const name = seg[4]
        const sub = seg[5]
        if (!LIVE.has(t.row.status)) return fail(res, 409, 'paused')
        if (!name) {
          if (method === 'POST') {
            const body = await readJson(req)
            const port = body.port ?? (body.portal || body.health ? 30000 + t.services.length + 10 : null)
            const created = service(id, { name: body.name, command: body.command, cwd: body.cwd ?? '/home/valet/workspace/repo', port, portal: body.portal ? { path: '/', title: body.name } : false, health: body.health ?? null, uptimeSeconds: 2, updatedAt: now() })
            t.services = [...t.services.filter((s) => s.name !== created.name), created].sort((a, b) => a.name.localeCompare(b.name))
            publishServices(id)
            await sleep(700)
            return send(res, 201, { service: created, readiness: port === null ? { ok: true, status: 'skipped', httpStatus: null, error: null } : { ok: true, status: 'listening', httpStatus: null, error: null } })
          }
          return send(res, 200, { services: t.services })
        }
        const svc = t.services.find((s) => s.name === name)
        if (!svc) return fail(res, 404, `no service named ${name}`)
        if (sub === 'logs') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end(Array.from({ length: 30 }, (_, i) => `${new Date(Date.now() - (30 - i) * 1000).toISOString()} ${svc.name}: line ${i + 1}\n`).join(''))
        }
        if (method === 'DELETE') {
          t.services = t.services.filter((s) => s.name !== name)
          publishServices(id)
          return send(res, 204)
        }
        if (method === 'POST' && (sub === 'start' || sub === 'stop' || sub === 'restart')) {
          await sleep(500)
          Object.assign(svc, sub === 'stop' ? { state: 'stopped', pid: null, uptimeSeconds: null } : { state: 'running', pid: 5000 + Math.floor(Math.random() * 100), uptimeSeconds: 1, lastExitCode: null, restarts: sub === 'restart' ? svc.restarts + 1 : svc.restarts })
          publishServices(id)
          const readiness = sub === 'stop' || svc.port === null ? { ok: true, status: 'skipped', httpStatus: null, error: null } : { ok: true, status: svc.health ? 'responding' : 'listening', httpStatus: svc.health ? 200 : null, error: null }
          return send(res, 200, { service: svc, readiness })
        }
        return fail(res, 404, 'Not found')
      }
      case 'push':
        await sleep(600)
        return send(res, 200, { branch: t.row.branch, pushed: true })
      case 'pr': {
        const body = await readJson(req)
        const project = projects.get(t.row.projectId)
        if (project?.source === 'blank') return fail(res, 400, 'Blank projects have no remote')
        if (t.row.pr) return fail(res, 409, 'A pull request already exists')
        await sleep(800)
        const number = 400 + Math.floor(Math.random() * 100)
        touch(id, { pr: { url: `${project.repoUrl}/pull/${number}`, number, state: 'open' }, title: body.title || t.row.title })
        return send(res, 200, t.row)
      }
      default:
        return fail(res, 404, 'Not found')
    }
  }

  fail(res, 404, `No route for ${method} ${path}`)
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err)
    if (!res.headersSent) fail(res, 500, err.message)
  })
})

// ---------------------------------------------------------------------------
// WebSockets
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  const seg = url.pathname.split('/').filter(Boolean)
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/api/stream') {
      globalSubscribers.add(ws)
      ws.on('close', () => globalSubscribers.delete(ws))
      return
    }
    if (seg[0] === 'api' && seg[1] === 'threads' && seg[2]) {
      const t = threads.get(seg[2])
      if (!t) return ws.close(4004, 'Thread not found')
      switch (seg[3]) {
        case 'stream': {
          const since = Number(url.searchParams.get('since') ?? 0)
          for (const e of t.events) if (e.seq > since) ws.send(JSON.stringify({ t: 'event', seq: e.seq, event: e.event }))
          ws.send(JSON.stringify({ t: 'thread', thread: t.row }))
          ws.send(JSON.stringify({ t: 'portals', portals: t.portals }))
          ws.send(JSON.stringify({ t: 'services', services: t.services }))
          ws.send(JSON.stringify({ t: 'live' }))
          t.subscribers.add(ws)
          ws.on('close', () => t.subscribers.delete(ws))
          // Uptime ticks like the real poller.
          const tick = setInterval(() => {
            for (const s of t.services) if (s.state === 'running' && s.uptimeSeconds !== null) s.uptimeSeconds += 3
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'services', services: t.services }))
          }, 3000)
          ws.on('close', () => clearInterval(tick))
          return
        }
        case 'pty': {
          if (!LIVE.has(t.row.status)) return ws.close(4009, t.row.status)
          const write = (s) => ws.send(JSON.stringify({ t: 'data', data: Buffer.from(s, 'utf8').toString('base64') }))
          write(`\x1b[2mvalet mock pty (tmux: valet-terminal)\x1b[0m\r\nvalet@sandbox:~/workspace/repo$ `)
          let line = ''
          ws.on('message', (raw) => {
            const frame = JSON.parse(String(raw))
            if (frame.t === 'resize') return write(`\r\n\x1b[2m[${frame.cols}x${frame.rows}]\x1b[0m\r\nvalet@sandbox:~/workspace/repo$ ${line}`)
            const text = Buffer.from(frame.data, 'base64').toString('utf8')
            for (const ch of text) {
              if (ch === '\r') {
                write(`\r\n`)
                if (line === 'exit') return ws.send(JSON.stringify({ t: 'exit', code: 0 }))
                if (line.trim()) write(`${line}: command not found\r\n`)
                line = ''
                write('valet@sandbox:~/workspace/repo$ ')
              } else if (ch === '\x7f') {
                if (line) {
                  line = line.slice(0, -1)
                  write('\b \b')
                }
              } else {
                line += ch
                write(ch)
              }
            }
          })
          return
        }
        case 'services': {
          const svc = t.services.find((s) => s.name === seg[4])
          if (!svc || seg[5] !== 'logs') return ws.close(4004, 'Not found')
          const lines = Number(url.searchParams.get('lines') ?? 200)
          const frame = (text) => JSON.stringify({ t: 'data', data: Buffer.from(text, 'utf8').toString('base64') })
          ws.send(frame(Array.from({ length: Math.min(lines, 40) }, (_, i) => `${new Date(Date.now() - (40 - i) * 1000).toISOString()} \x1b[32mready\x1b[0m ${svc.name} request ${i + 1}\n`).join('')))
          let n = 0
          const timer = setInterval(() => ws.readyState === ws.OPEN && ws.send(frame(`${now()} ${svc.name} tick ${++n}\n`)), 1500)
          ws.on('close', () => clearInterval(timer))
          return
        }
        case 'vnc':
          return ws.close(1011, 'No desktop in the mock')
        default:
          return ws.close(4004, 'Not found')
      }
    }
    ws.close(4004, 'Not found')
  })
})

server.listen(PORT, () => console.log(`mock core on http://localhost:${PORT}`))
