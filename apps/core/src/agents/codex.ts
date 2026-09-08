import type { AdapterStartOptions, AgentProcess, FileChange, Question, RateLimitInfo, ThreadEvent, UsageInfo } from '@valet/shared'
import { logger } from '../logger.js'
import type * as P from './codex-types.js'
import { nowIso, truncateOutput, type Adapter, type AdapterHooks, type PromptImage } from './types.js'

const log = logger('codex')

const REQUEST_TIMEOUT_MS = 60_000
const MODEL_LIST_TIMEOUT_MS = 10_000
const STOP_GRACE_MS = 5_000
const STDERR_KEEP = 4096

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
type ServerRequest = { rpcId: P.RequestId; kind: 'command' | 'file' | 'question'; turnId: string }

export class CodexAdapter implements Adapter {
  readonly supportsSteer = true
  started = false
  busy = false

  private proc: AgentProcess | null = null
  private hooks: AdapterHooks | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private codexThreadId: string | null = null
  private currentTurn: { turnId: string; codexTurnId: string | null; started: Promise<void> } | null = null
  private readonly turnIds = new Map<string, string>()
  private readonly serverRequests = new Map<string, ServerRequest>()
  private lastUsage: P.ThreadTokenUsageUpdatedNotification['tokenUsage'] | null = null
  private rateLimits: RateLimitInfo[] | null = null
  private stopping = false
  private stderrTail = ''

  constructor(private readonly executable = 'codex') {}

  async start(opts: AdapterStartOptions & AdapterHooks): Promise<void> {
    if (this.started) throw new Error('adapter already started')
    this.hooks = opts
    this.stopping = false
    this.stderrTail = ''

    const proc = await opts.runner.spawn({
      argv: [this.executable, 'app-server'],
      cwd: opts.cwd,
      env: { RUST_LOG: 'error', ...opts.env },
    })
    this.proc = proc
    this.started = true
    proc.onStdoutLine((line) => this.onLine(line))
    proc.onStderr((chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_KEEP)
    })
    void proc.exited.then((info) => this.onExit(info))

    try {
      const init: P.InitializeParams = {
        clientInfo: { name: 'valet', title: 'Valet', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }
      await this.request('initialize', init)
      await this.notify('initialized', {})
      void this.refreshModels()

      const overrides: P.ThreadStartParams = {
        cwd: opts.cwd,
        model: opts.model,
        sandbox: 'danger-full-access',
        approvalPolicy: opts.permissions === 'auto' ? 'never' : 'on-request',
        config: { model_reasoning_effort: 'medium' },
        developerInstructions: opts.systemPromptSuffix,
      }
      let thread: P.Thread | null = null
      if (opts.resumeSessionId) {
        try {
          const params: P.ThreadResumeParams = { ...overrides, threadId: opts.resumeSessionId, excludeTurns: true }
          thread = ((await this.request('thread/resume', params)) as P.ThreadStartResponse).thread
        } catch (err) {
          log.warn('thread/resume failed; starting a new thread', { err })
        }
      }
      if (!thread) thread = ((await this.request('thread/start', overrides)) as P.ThreadStartResponse).thread
      this.codexThreadId = thread.id
      opts.onSessionId(thread.id)
    } catch (err) {
      await this.stop()
      throw err
    }
  }

  private async refreshModels(): Promise<void> {
    try {
      const res = (await this.request('model/list', { limit: 100, includeHidden: false }, MODEL_LIST_TIMEOUT_MS)) as P.ModelListResponse
      const models = res.data.filter((m) => !m.hidden).map((m) => ({ id: m.id, label: m.displayName || m.id }))
      if (models.length > 0) this.hooks?.onModels?.(models)
    } catch (err) {
      log.debug('model/list unavailable', { err })
    }
  }

  // ---- JSON-RPC ------------------------------------------------------------------

  private async write(msg: P.RpcMessage): Promise<void> {
    if (!this.proc) throw new Error('codex is not running')
    await this.proc.write(`${JSON.stringify(msg)}\n`)
  }

  private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex ${method}: no response within ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.write({ id, method, params }).catch((err: unknown) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  private notify(method: string, params: unknown): Promise<void> {
    return this.write({ method, params })
  }

  private respond(id: P.RequestId, result: unknown): void {
    void this.write({ id, result }).catch((err: unknown) => log.warn('failed to answer server request', { err }))
  }

  private respondError(id: P.RequestId, message: string): void {
    void this.write({ id, error: { code: -32000, message } }).catch((err: unknown) =>
      log.warn('failed to answer server request', { err }),
    )
  }

  private onLine(raw: string): void {
    if (!raw.trim()) return
    let msg: P.RpcMessage
    try {
      msg = JSON.parse(raw) as P.RpcMessage
    } catch {
      log.debug('non-JSON stdout line', { line: raw.slice(0, 200) })
      return
    }
    try {
      if ('id' in msg && msg.id !== undefined && msg.id !== null) {
        if ('method' in msg) this.onServerRequest(msg as P.RpcRequest)
        else this.onResponse(msg as P.RpcResponse)
      } else if ('method' in msg) {
        this.onNotification(msg as P.RpcNotification)
      }
    } catch (err) {
      log.error('failed to handle message', { err, method: (msg as P.RpcRequest).method })
    }
  }

  private onResponse(msg: P.RpcResponse): void {
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (msg.error) pending.reject(new Error(`codex ${pending.method}: ${msg.error.message}`))
    else pending.resolve(msg.result)
  }

  // ---- turns ---------------------------------------------------------------------

  private emit(event: ThreadEvent): void {
    this.hooks?.onEvent(event)
  }

  private toInput(prompt: string, images: PromptImage[]): P.UserInput[] {
    const input: P.UserInput[] = [{ type: 'text', text: prompt, text_elements: [] }]
    for (const img of images) input.push({ type: 'image', url: img.dataUrl })
    return input
  }

  async sendTurn(turnId: string, prompt: string, images: PromptImage[], mode: 'queue' | 'steer'): Promise<void> {
    if (!this.started || !this.codexThreadId) throw new Error('codex is not running')
    const threadId = this.codexThreadId
    const input = this.toInput(prompt, images)

    if (this.busy && this.currentTurn) {
      if (mode !== 'steer') throw new Error('a turn is already in progress')
      await this.currentTurn.started
      const expectedTurnId = this.currentTurn.codexTurnId
      if (!expectedTurnId) throw new Error('a turn is already in progress')
      const params: P.TurnSteerParams = { threadId, input, expectedTurnId }
      await this.request('turn/steer', params)
      return
    }

    this.busy = true
    this.lastUsage = null
    let resolveStarted!: () => void
    const started = new Promise<void>((r) => {
      resolveStarted = r
    })
    const turn = { turnId, codexTurnId: null as string | null, started }
    this.currentTurn = turn
    try {
      const params: P.TurnStartParams = { threadId, input }
      const res = (await this.request('turn/start', params)) as P.TurnStartResponse
      turn.codexTurnId = res.turn.id
      this.turnIds.set(res.turn.id, turnId)
    } catch (err) {
      if (this.currentTurn === turn) {
        this.busy = false
        this.currentTurn = null
      }
      throw err
    } finally {
      resolveStarted()
    }
  }

  async interrupt(): Promise<void> {
    if (!this.busy || !this.currentTurn || !this.codexThreadId) return
    await this.currentTurn.started
    const codexTurnId = this.currentTurn.codexTurnId
    if (!codexTurnId) return
    const params: P.TurnInterruptParams = { threadId: this.codexThreadId, turnId: codexTurnId }
    await this.request('turn/interrupt', params)
  }

  async answerPermission(requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    const req = this.serverRequests.get(requestId)
    if (!req || req.kind === 'question') throw new Error('unknown permission request')
    this.serverRequests.delete(requestId)
    const d: P.ApprovalDecision = decision === 'allow' ? 'accept' : 'decline'
    this.respond(req.rpcId, { decision: d })
    this.emit({ type: 'permission.response', turnId: req.turnId, requestId, decision, by: 'user' })
  }

  async answerQuestion(requestId: string, answers: Record<string, string[]>): Promise<void> {
    const req = this.serverRequests.get(requestId)
    if (!req || req.kind !== 'question') throw new Error('unknown question')
    this.serverRequests.delete(requestId)
    const response: P.ToolRequestUserInputResponse = { answers: {} }
    for (const [id, picked] of Object.entries(answers)) response.answers[id] = { answers: picked }
    this.respond(req.rpcId, response)
    this.emit({ type: 'question.response', turnId: req.turnId, requestId, answers })
  }

  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.stopping = true
    await proc.closeStdin().catch(() => undefined)
    const exited = await Promise.race([proc.exited.then(() => true), sleep(1000).then(() => false)])
    if (!exited) {
      await proc.signal('SIGTERM').catch(() => undefined)
      const gone = await Promise.race([proc.exited.then(() => true), sleep(STOP_GRACE_MS).then(() => false)])
      if (!gone) await proc.signal('SIGKILL').catch(() => undefined)
    }
    await proc.exited
    this.reset()
  }

  private reset(): void {
    this.proc = null
    this.started = false
    this.busy = false
    this.currentTurn = null
    this.codexThreadId = null
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('codex exited'))
    }
    this.pending.clear()
    this.serverRequests.clear()
  }

  private onExit(info: { code: number | null; signal: string | null }): void {
    if (this.stopping) return
    const duringTurn = this.busy
    const turn = this.currentTurn
    const stderr = this.stderrTail.trim()
    const detail = stderr ? `: ${stderr.split('\n').slice(-3).join(' ')}` : ''
    const message = `Codex exited (code ${info.code ?? 'null'}${info.signal ? `, signal ${info.signal}` : ''})${detail}`
    this.reset()
    if (duringTurn && turn) {
      this.emit({ type: 'error', turnId: turn.turnId, message, at: nowIso() })
      this.emit({ type: 'turn.end', turnId: turn.turnId, status: 'failed', error: message, usage: null, at: nowIso() })
    }
    this.hooks?.onExit({ code: info.code, signal: info.signal, duringTurn })
  }

  private turnIdFor(codexTurnId: string): string {
    return this.turnIds.get(codexTurnId) ?? this.currentTurn?.turnId ?? codexTurnId
  }

  // ---- notifications ----------------------------------------------------------------

  private onNotification(msg: P.RpcNotification): void {
    const p = msg.params as Record<string, unknown> | undefined
    switch (msg.method) {
      case 'item/started':
        this.onItemStarted(msg.params as P.ItemStartedNotification)
        return
      case 'item/completed':
        this.onItemCompleted(msg.params as P.ItemCompletedNotification)
        return
      case 'item/agentMessage/delta': {
        const n = msg.params as P.ItemDeltaNotification
        this.emit({ type: 'text.delta', turnId: this.turnIdFor(n.turnId), itemId: n.itemId, delta: n.delta })
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const n = msg.params as P.ItemDeltaNotification
        this.emit({ type: 'reasoning.delta', turnId: this.turnIdFor(n.turnId), itemId: n.itemId, delta: n.delta })
        return
      }
      case 'item/commandExecution/outputDelta': {
        const n = msg.params as P.ItemDeltaNotification
        this.emit({ type: 'tool.outputDelta', turnId: this.turnIdFor(n.turnId), itemId: n.itemId, delta: n.delta })
        return
      }
      case 'turn/started': {
        const n = msg.params as P.TurnStartedNotification
        if (this.currentTurn && !this.currentTurn.codexTurnId) this.turnIds.set(n.turn.id, this.currentTurn.turnId)
        return
      }
      case 'turn/completed':
        this.onTurnCompleted(msg.params as P.TurnCompletedNotification)
        return
      case 'thread/tokenUsage/updated':
        this.lastUsage = (msg.params as P.ThreadTokenUsageUpdatedNotification).tokenUsage
        return
      case 'account/rateLimits/updated': {
        const n = msg.params as P.AccountRateLimitsUpdatedNotification
        const limits: RateLimitInfo[] = []
        for (const [name, w] of [
          ['primary', n.rateLimits?.primary],
          ['secondary', n.rateLimits?.secondary],
        ] as const) {
          if (!w) continue
          limits.push({
            window: windowName(name, w.windowDurationMins),
            utilization: Math.min(1, Math.max(0, w.usedPercent / 100)),
            resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null,
          })
        }
        if (limits.length > 0) this.rateLimits = limits
        return
      }
      case 'error': {
        const n = msg.params as P.ErrorNotification
        const message = n.willRetry ? `${n.error.message} (retrying)` : n.error.message
        this.emit({ type: 'error', turnId: n.turnId ? this.turnIdFor(n.turnId) : null, message, at: nowIso() })
        return
      }
      case 'warning': {
        const n = msg.params as P.WarningNotification
        this.emit({ type: 'log', level: 'warn', message: n.message, at: nowIso() })
        return
      }
      default:
        log.debug('ignored notification', { method: msg.method, keys: p ? Object.keys(p) : [] })
        return
    }
  }

  private onItemStarted(n: P.ItemStartedNotification): void {
    const turnId = this.turnIdFor(n.turnId)
    const item = n.item
    switch (item.type) {
      case 'commandExecution': {
        const it = item as Extract<P.ThreadItem, { type: 'commandExecution' }>
        this.emit({
          type: 'tool.start',
          turnId,
          itemId: it.id,
          name: 'bash',
          vendorName: 'commandExecution',
          input: { command: it.command, cwd: it.cwd },
          title: `$ ${it.command}`.trim(),
          parentItemId: null,
        })
        return
      }
      case 'fileChange': {
        const it = item as Extract<P.ThreadItem, { type: 'fileChange' }>
        const changes = fileChanges(it.changes)
        this.emit({
          type: 'tool.start',
          turnId,
          itemId: it.id,
          name: 'edit',
          vendorName: 'fileChange',
          input: { changes: changes.map((c) => ({ path: c.path, kind: c.kind })) },
          title: fileChangeTitle(changes),
          parentItemId: null,
        })
        return
      }
      case 'mcpToolCall': {
        const it = item as Extract<P.ThreadItem, { type: 'mcpToolCall' }>
        this.emit({
          type: 'tool.start',
          turnId,
          itemId: it.id,
          name: `mcp:${it.server}:${it.tool}`,
          vendorName: 'mcpToolCall',
          input: it.arguments,
          title: `${it.server}: ${it.tool}`,
          parentItemId: null,
        })
        return
      }
      case 'webSearch': {
        const it = item as Extract<P.ThreadItem, { type: 'webSearch' }>
        this.emit({
          type: 'tool.start',
          turnId,
          itemId: it.id,
          name: 'web_search',
          vendorName: 'webSearch',
          input: { query: it.query },
          title: `Searched the web for ${it.query ?? ''}`.trim(),
          parentItemId: null,
        })
        return
      }
      case 'plan': {
        this.emit({
          type: 'tool.start',
          turnId,
          itemId: item.id,
          name: 'todo',
          vendorName: 'plan',
          input: {},
          title: 'Updated tasks',
          parentItemId: null,
        })
        return
      }
      case 'imageView': {
        const it = item as Extract<P.ThreadItem, { type: 'imageView' }>
        this.emit({
          type: 'tool.start',
          turnId,
          itemId: it.id,
          name: 'read',
          vendorName: 'imageView',
          input: { path: it.path },
          title: `Read ${it.path}`,
          parentItemId: null,
        })
        return
      }
      default:
        return
    }
  }

  private onItemCompleted(n: P.ItemCompletedNotification): void {
    const turnId = this.turnIdFor(n.turnId)
    const item = n.item
    switch (item.type) {
      case 'agentMessage': {
        const it = item as Extract<P.ThreadItem, { type: 'agentMessage' }>
        this.emit({ type: 'text.end', turnId, itemId: it.id, text: it.text })
        return
      }
      case 'reasoning': {
        const it = item as Extract<P.ThreadItem, { type: 'reasoning' }>
        const text = (it.summary.length > 0 ? it.summary : it.content).join('\n\n')
        this.emit({ type: 'reasoning.end', turnId, itemId: it.id, text })
        return
      }
      case 'commandExecution': {
        const it = item as Extract<P.ThreadItem, { type: 'commandExecution' }>
        const declined = it.status === 'declined'
        this.emit({
          type: 'tool.output',
          turnId,
          itemId: it.id,
          output: truncateOutput(declined ? 'Declined' : (it.aggregatedOutput ?? '')),
          isError: it.status === 'failed' || declined || (it.exitCode !== null && it.exitCode !== 0),
          exitCode: it.exitCode,
          fileChanges: null,
        })
        return
      }
      case 'fileChange': {
        const it = item as Extract<P.ThreadItem, { type: 'fileChange' }>
        this.emit({
          type: 'tool.output',
          turnId,
          itemId: it.id,
          output: it.status === 'completed' ? '' : it.status === 'declined' ? 'Declined' : 'Failed to apply changes',
          isError: it.status !== 'completed',
          exitCode: null,
          fileChanges: fileChanges(it.changes),
        })
        return
      }
      case 'mcpToolCall': {
        const it = item as Extract<P.ThreadItem, { type: 'mcpToolCall' }>
        const output = it.error ? it.error.message : it.result ? JSON.stringify(it.result.structuredContent ?? it.result.content, null, 2) : ''
        this.emit({
          type: 'tool.output',
          turnId,
          itemId: it.id,
          output: truncateOutput(output),
          isError: it.status === 'failed' || it.error !== null,
          exitCode: null,
          fileChanges: null,
        })
        return
      }
      case 'webSearch': {
        const it = item as Extract<P.ThreadItem, { type: 'webSearch' }>
        this.emit({
          type: 'tool.output',
          turnId,
          itemId: it.id,
          output: truncateOutput(it.results ? JSON.stringify(it.results, null, 2) : ''),
          isError: false,
          exitCode: null,
          fileChanges: null,
        })
        return
      }
      case 'plan': {
        const it = item as Extract<P.ThreadItem, { type: 'plan' }>
        this.emit({ type: 'tool.output', turnId, itemId: it.id, output: it.text, isError: false, exitCode: null, fileChanges: null })
        return
      }
      case 'imageView': {
        this.emit({ type: 'tool.output', turnId, itemId: item.id, output: '', isError: false, exitCode: null, fileChanges: null })
        return
      }
      default:
        return
    }
  }

  private onTurnCompleted(n: P.TurnCompletedNotification): void {
    const turnId = this.turnIdFor(n.turn.id)
    const status = n.turn.status === 'interrupted' ? 'interrupted' : n.turn.status === 'failed' ? 'failed' : 'completed'
    const error = status === 'failed' ? (n.turn.error?.message ?? 'Turn failed') : null

    let usage: UsageInfo | null = null
    if (this.lastUsage) {
      const last = this.lastUsage.last
      usage = {
        inputTokens: last.inputTokens,
        outputTokens: last.outputTokens,
        cachedInputTokens: last.cachedInputTokens,
        contextUsed: last.totalTokens,
        ...(this.lastUsage.modelContextWindow !== null ? { contextWindow: this.lastUsage.modelContextWindow } : {}),
      }
      this.emit({ type: 'usage', turnId, usage, rateLimits: this.rateLimits })
    }

    for (const [requestId, req] of this.serverRequests) {
      if (req.turnId !== turnId) continue
      this.serverRequests.delete(requestId)
      if (req.kind === 'question') this.respondError(req.rpcId, 'turn ended')
      else {
        this.respond(req.rpcId, { decision: 'cancel' })
        this.emit({ type: 'permission.response', turnId, requestId, decision: 'deny', by: 'system' })
      }
    }

    if (this.currentTurn && (this.currentTurn.codexTurnId === n.turn.id || this.currentTurn.codexTurnId === null)) {
      this.currentTurn = null
      this.busy = false
    }
    this.turnIds.delete(n.turn.id)
    this.emit({ type: 'turn.end', turnId, status, error, usage, at: nowIso() })
  }

  // ---- server requests --------------------------------------------------------------

  private onServerRequest(msg: P.RpcRequest): void {
    const requestId = String(msg.id)
    switch (msg.method) {
      case 'item/commandExecution/requestApproval': {
        const p = msg.params as P.CommandExecutionRequestApprovalParams
        const turnId = this.turnIdFor(p.turnId)
        this.serverRequests.set(requestId, { rpcId: msg.id, kind: 'command', turnId })
        this.emit({
          type: 'permission.request',
          turnId,
          requestId,
          toolName: 'bash',
          input: { command: p.command ?? null, cwd: p.cwd ?? null },
          description: p.reason ?? null,
          itemId: p.itemId,
        })
        return
      }
      case 'item/fileChange/requestApproval': {
        const p = msg.params as P.FileChangeRequestApprovalParams
        const turnId = this.turnIdFor(p.turnId)
        this.serverRequests.set(requestId, { rpcId: msg.id, kind: 'file', turnId })
        this.emit({
          type: 'permission.request',
          turnId,
          requestId,
          toolName: 'edit',
          input: {},
          description: p.reason ?? null,
          itemId: p.itemId,
        })
        return
      }
      case 'item/tool/requestUserInput': {
        const p = msg.params as P.ToolRequestUserInputParams
        const turnId = this.turnIdFor(p.turnId)
        const questions: Question[] = p.questions.map((q) => ({
          id: q.id,
          question: q.header ? `${q.header}: ${q.question}` : q.question,
          options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description || null })),
          multiSelect: false,
        }))
        this.serverRequests.set(requestId, { rpcId: msg.id, kind: 'question', turnId })
        this.emit({ type: 'question.request', turnId, requestId, questions, itemId: p.itemId })
        return
      }
      case 'account/chatgptAuthTokens/refresh':
        // Codex falls back to its own refresh when the client declines.
        this.respondError(msg.id, 'token refresh is not handled by the client')
        return
      default:
        this.respondError(msg.id, `unsupported request: ${msg.method}`)
        return
    }
  }
}

// ---- helpers -------------------------------------------------------------------------

function fileChanges(changes: P.FileUpdateChange[]): FileChange[] {
  return changes.map((c) => ({
    path: c.path,
    kind: c.kind.type === 'update' ? (c.kind.move_path ? 'rename' : 'update') : c.kind.type,
    diff: c.diff || null,
  }))
}

function fileChangeTitle(changes: FileChange[]): string {
  const first = changes[0]
  if (!first) return 'Edited files'
  if (changes.length === 1) return `Edited ${first.path}`
  return `Edited ${changes.length} files`
}

function windowName(slot: 'primary' | 'secondary', mins: number | null): string {
  if (mins === 300) return 'five_hour'
  if (mins === 10080) return 'seven_day'
  if (mins) return `${mins}m`
  return slot
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
