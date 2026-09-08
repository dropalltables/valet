import crypto from 'node:crypto'
import { toolTitle, type AdapterStartOptions, type AgentProcess, type Question, type RateLimitInfo, type ThreadEvent, type UsageInfo } from '@valet/shared'
import { nanoid } from 'nanoid'
import { logger } from '../logger.js'
import { normalizeClaudeTool } from './tool-names.js'
import { nowIso, parseDataUrl, truncateOutput, type Adapter, type AdapterHooks, type PromptImage } from './types.js'

const log = logger('claude')

const INTERRUPT_GRACE_MS = 10_000
const STOP_GRACE_MS = 5_000
const STDERR_KEEP = 4096

// ---- wire shapes (the subset we read) --------------------------------------

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'redacted_thinking' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: string | Array<{ type: string; text?: string }>; is_error?: boolean }
  | { type: string }

type StreamEvent =
  | { type: 'message_start'; message?: { usage?: RawUsage } }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | {
      type: 'content_block_delta'
      index: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'signature_delta' }
        | { type: string }
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; usage?: RawUsage }
  | { type: 'message_stop' }
  | { type: string }

type RawUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type Line =
  | { type: 'system'; subtype: 'init'; session_id: string; model?: string }
  | { type: 'system'; subtype: string }
  | { type: 'rate_limit_event'; rate_limit_info?: { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } }
  | { type: 'stream_event'; event: StreamEvent; parent_tool_use_id: string | null }
  | { type: 'assistant'; message: { content: ContentBlock[] }; parent_tool_use_id: string | null }
  | { type: 'user'; message: { content: ContentBlock[] | string }; parent_tool_use_id: string | null; isReplay?: boolean }
  | {
      type: 'result'
      subtype: string
      is_error: boolean
      result?: string
      total_cost_usd?: number
      usage?: RawUsage
      modelUsage?: Record<string, { contextWindow?: number }>
      terminal_reason?: string
      errors?: string[]
    }
  | {
      type: 'control_request'
      request_id: string
      request: {
        subtype: string
        tool_name?: string
        input?: unknown
        tool_use_id?: string
        description?: string
      }
    }
  | { type: 'control_response'; response: { subtype: string; request_id: string; error?: string } }
  | { type: string }

// ---- per-turn streaming state -------------------------------------------------

type OpenBlock = {
  itemId: string
  kind: 'text' | 'thinking' | 'tool_use' | 'other'
  toolId: string | null
}

type TurnState = {
  turnId: string
  /** Blocks currently streaming, by parent tool id ('' for the main agent) then block index. */
  streaming: Map<string, Map<number, OpenBlock>>
  /** Stopped blocks awaiting their `assistant` line, in order, per parent. */
  awaiting: Map<string, OpenBlock[]>
  interrupted: boolean
  lastContextUsed: number | null
}

type PendingRequest = { kind: 'permission' | 'question'; toolName: string; input: unknown }

const parentKey = (parent: string | null): string => parent ?? ''

export class ClaudeAdapter implements Adapter {
  readonly supportsSteer = false
  started = false
  busy = false

  private proc: AgentProcess | null = null
  private hooks: AdapterHooks | null = null
  private turn: TurnState | null = null
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly controlWaiters = new Map<string, () => void>()
  private rateLimits: RateLimitInfo[] | null = null
  private lastTotalCost = 0
  private stopping = false
  private stderrTail = ''

  constructor(private readonly executable = 'claude') {}

  get pid(): number | null {
    return this.proc?.pid ?? null
  }

  async start(opts: AdapterStartOptions & AdapterHooks): Promise<void> {
    if (this.started) throw new Error('adapter already started')
    this.hooks = opts
    this.stopping = false
    this.stderrTail = ''
    this.lastTotalCost = 0

    const argv = [
      this.executable,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      opts.permissions === 'auto' ? 'bypassPermissions' : 'acceptEdits',
      ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : ['--session-id', crypto.randomUUID()]),
      '--model',
      opts.model,
      '--append-system-prompt',
      opts.systemPromptSuffix,
      '--setting-sources',
      'project',
      ...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath] : []),
      // Valet's generated file is the only MCP source: no user scope, no claude.ai
      // connectors, and no unreviewed `.mcp.json` from the repository.
      '--strict-mcp-config',
    ]
    const env: Record<string, string> = {
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_ERROR_REPORTING: '1',
      TERM: 'xterm-256color',
      ...opts.env,
    }

    const proc = await opts.runner.spawn({ argv, cwd: opts.cwd, env })
    this.proc = proc
    this.started = true
    proc.onStdoutLine((line) => this.onLine(line))
    proc.onStderr((chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_KEEP)
    })
    void proc.exited.then((info) => this.onExit(info))
  }

  private emit(event: ThreadEvent): void {
    this.hooks?.onEvent(event)
  }

  private async writeLine(obj: unknown): Promise<void> {
    if (!this.proc) throw new Error('claude is not running')
    await this.proc.write(`${JSON.stringify(obj)}\n`)
  }

  async sendTurn(turnId: string, prompt: string, images: PromptImage[], mode: 'queue' | 'steer'): Promise<void> {
    if (!this.started) throw new Error('claude is not running')
    if (this.busy) throw new Error(mode === 'steer' ? 'steering is not supported for Claude Code' : 'a turn is already in progress')
    const content: unknown[] = [{ type: 'text', text: prompt }]
    for (const img of images) {
      const { mediaType, base64 } = parseDataUrl(img.dataUrl, img.mediaType)
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } })
    }
    this.turn = { turnId, streaming: new Map(), awaiting: new Map(), interrupted: false, lastContextUsed: null }
    this.busy = true
    try {
      await this.writeLine({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })
    } catch (err) {
      this.busy = false
      this.turn = null
      throw err
    }
  }

  async interrupt(): Promise<void> {
    if (!this.busy || !this.turn || !this.proc) return
    const turn = this.turn
    turn.interrupted = true
    const requestId = crypto.randomUUID()
    const acked = new Promise<void>((resolve) => this.controlWaiters.set(requestId, resolve))
    await this.writeLine({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } })
    const timer = setTimeout(() => {
      this.controlWaiters.delete(requestId)
      if (this.turn === turn && this.busy) void this.proc?.signal('SIGINT')
    }, INTERRUPT_GRACE_MS)
    void acked.finally(() => clearTimeout(timer))
  }

  async answerPermission(requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) throw new Error('unknown permission request')
    this.pendingRequests.delete(requestId)
    const response =
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: 'Denied by the user in Valet', interrupt: false }
    await this.writeLine({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    if (this.turn) this.emit({ type: 'permission.response', turnId: this.turn.turnId, requestId, decision, by: 'user' })
  }

  async answerQuestion(requestId: string, answers: Record<string, string[]>): Promise<void> {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) throw new Error('unknown question')
    this.pendingRequests.delete(requestId)
    const input = (pending.input ?? {}) as { questions?: unknown[] }
    // AskUserQuestion keys answers by question text; core keys them by question id.
    const byText: Record<string, string> = {}
    for (const q of (input.questions ?? []) as Array<{ question?: string }>) {
      const text = q.question ?? ''
      const id = questionId(text)
      const picked = answers[id] ?? answers[text]
      if (picked) byText[text] = picked.join(', ')
    }
    await this.writeLine({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'allow', updatedInput: { ...input, answers: byText } },
      },
    })
    if (this.turn) this.emit({ type: 'question.response', turnId: this.turn.turnId, requestId, answers })
  }

  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.stopping = true
    await proc.closeStdin().catch(() => undefined)
    await proc.signal('SIGTERM').catch(() => undefined)
    const exited = await Promise.race([proc.exited.then(() => true), sleep(STOP_GRACE_MS).then(() => false)])
    if (!exited) await proc.signal('SIGKILL').catch(() => undefined)
    await proc.exited
    this.reset()
  }

  private reset(): void {
    this.proc = null
    this.started = false
    this.busy = false
    this.turn = null
    this.pendingRequests.clear()
    this.controlWaiters.clear()
  }

  private onExit(info: { code: number | null; signal: string | null }): void {
    if (this.stopping) return
    const duringTurn = this.busy
    const turn = this.turn
    const stderr = this.stderrTail.trim()
    const detail = stderr ? `: ${stderr.split('\n').slice(-3).join(' ')}` : ''
    const message = `Claude Code exited (code ${info.code ?? 'null'}${info.signal ? `, signal ${info.signal}` : ''})${detail}`
    this.reset()
    if (duringTurn && turn) {
      this.emit({ type: 'error', turnId: turn.turnId, message, at: nowIso() })
      this.emit({ type: 'turn.end', turnId: turn.turnId, status: 'failed', error: message, usage: null, at: nowIso() })
    }
    this.hooks?.onExit({ code: info.code, signal: info.signal, duringTurn })
  }

  // ---- stdout ----------------------------------------------------------------

  private onLine(raw: string): void {
    if (!raw.trim()) return
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      log.debug('non-JSON stdout line', { line: raw.slice(0, 200) })
      return
    }
    try {
      this.handle(line)
    } catch (err) {
      log.error('failed to handle line', { err, type: line.type })
    }
  }

  private handle(line: Line): void {
    switch (line.type) {
      case 'system': {
        if ('session_id' in line && line.subtype === 'init') this.hooks?.onSessionId(line.session_id)
        return
      }
      case 'rate_limit_event': {
        const windows = (line as Extract<Line, { type: 'rate_limit_event' }>).rate_limit_info?.unifiedWindows ?? {}
        const limits: RateLimitInfo[] = []
        for (const [name, w] of Object.entries(windows)) {
          if (!w || typeof w.utilization !== 'number') continue
          limits.push({
            window: name,
            utilization: w.utilization,
            resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null,
          })
        }
        if (limits.length > 0) this.rateLimits = limits
        return
      }
      case 'stream_event':
        this.onStreamEvent(line as Extract<Line, { type: 'stream_event' }>)
        return
      case 'assistant':
        this.onAssistant(line as Extract<Line, { type: 'assistant' }>)
        return
      case 'user':
        this.onUser(line as Extract<Line, { type: 'user' }>)
        return
      case 'result':
        this.onResult(line as Extract<Line, { type: 'result' }>)
        return
      case 'control_request':
        this.onControlRequest(line as Extract<Line, { type: 'control_request' }>)
        return
      case 'control_response': {
        const id = (line as Extract<Line, { type: 'control_response' }>).response?.request_id
        const waiter = id ? this.controlWaiters.get(id) : undefined
        if (id && waiter) {
          this.controlWaiters.delete(id)
          waiter()
        }
        return
      }
      default:
        return
    }
  }

  private onStreamEvent(line: Extract<Line, { type: 'stream_event' }>): void {
    const turn = this.turn
    if (!turn) return
    const parent = parentKey(line.parent_tool_use_id)
    const ev = line.event
    const streaming = mapGet(turn.streaming, parent, () => new Map<number, OpenBlock>())
    switch (ev.type) {
      case 'message_start': {
        for (const block of streaming.values()) mapGet(turn.awaiting, parent, () => []).push(block)
        streaming.clear()
        const usage = (ev as Extract<StreamEvent, { type: 'message_start' }>).message?.usage
        if (usage) turn.lastContextUsed = contextUsed(usage)
        return
      }
      case 'content_block_start': {
        const e = ev as Extract<StreamEvent, { type: 'content_block_start' }>
        const cb = e.content_block
        if (cb.type === 'tool_use') {
          const tool = cb as Extract<ContentBlock, { type: 'tool_use' }>
          streaming.set(e.index, { itemId: tool.id, kind: 'tool_use', toolId: tool.id })
          this.emit({
            type: 'tool.start',
            turnId: turn.turnId,
            itemId: tool.id,
            name: normalizeClaudeTool(tool.name),
            vendorName: tool.name,
            input: {},
            title: tool.name,
            parentItemId: line.parent_tool_use_id,
          })
        } else if (cb.type === 'text' || cb.type === 'thinking') {
          streaming.set(e.index, { itemId: nanoid(), kind: cb.type, toolId: null })
        } else {
          streaming.set(e.index, { itemId: nanoid(), kind: 'other', toolId: null })
        }
        return
      }
      case 'content_block_delta': {
        const e = ev as Extract<StreamEvent, { type: 'content_block_delta' }>
        const block = streaming.get(e.index)
        if (!block || parent !== '') return
        if (e.delta.type === 'text_delta' && block.kind === 'text') {
          this.emit({ type: 'text.delta', turnId: turn.turnId, itemId: block.itemId, delta: (e.delta as { text: string }).text })
        } else if (e.delta.type === 'thinking_delta' && block.kind === 'thinking') {
          this.emit({
            type: 'reasoning.delta',
            turnId: turn.turnId,
            itemId: block.itemId,
            delta: (e.delta as { thinking: string }).thinking,
          })
        }
        return
      }
      case 'content_block_stop': {
        const e = ev as Extract<StreamEvent, { type: 'content_block_stop' }>
        const block = streaming.get(e.index)
        if (!block) return
        streaming.delete(e.index)
        mapGet(turn.awaiting, parent, () => []).push(block)
        return
      }
      case 'message_delta': {
        const usage = (ev as Extract<StreamEvent, { type: 'message_delta' }>).usage
        if (usage) turn.lastContextUsed = contextUsed(usage)
        return
      }
      default:
        return
    }
  }

  /** Each `assistant` line carries one completed block; match it to its streamed counterpart. */
  private onAssistant(line: Extract<Line, { type: 'assistant' }>): void {
    const turn = this.turn
    if (!turn) return
    const parent = parentKey(line.parent_tool_use_id)
    const awaiting = mapGet(turn.awaiting, parent, () => [])
    const streaming = mapGet(turn.streaming, parent, () => new Map<number, OpenBlock>())

    for (const block of line.message.content) {
      if (block.type === 'tool_use') {
        const tool = block as Extract<ContentBlock, { type: 'tool_use' }>
        const idx = awaiting.findIndex((b) => b.toolId === tool.id)
        const streamed = idx >= 0 ? awaiting.splice(idx, 1)[0] : [...streaming.values()].find((b) => b.toolId === tool.id)
        const name = normalizeClaudeTool(tool.name)
        const title = toolTitle(name, tool.input)
        if (streamed) {
          this.emit({ type: 'tool.input', turnId: turn.turnId, itemId: tool.id, input: tool.input, title })
        } else {
          this.emit({
            type: 'tool.start',
            turnId: turn.turnId,
            itemId: tool.id,
            name,
            vendorName: tool.name,
            input: tool.input,
            title,
            parentItemId: line.parent_tool_use_id,
          })
        }
        continue
      }
      if (parent !== '') continue
      if (block.type === 'text') {
        const itemId = takeBlock(awaiting, 'text') ?? takeStreaming(streaming, 'text') ?? nanoid()
        this.emit({ type: 'text.end', turnId: turn.turnId, itemId, text: (block as { text: string }).text })
      } else if (block.type === 'thinking') {
        const itemId = takeBlock(awaiting, 'thinking') ?? takeStreaming(streaming, 'thinking') ?? nanoid()
        this.emit({ type: 'reasoning.end', turnId: turn.turnId, itemId, text: (block as { thinking: string }).thinking })
      }
    }
  }

  private onUser(line: Extract<Line, { type: 'user' }>): void {
    const turn = this.turn
    if (!turn || line.isReplay) return
    const content = line.message.content
    if (typeof content === 'string') return
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const r = block as Extract<ContentBlock, { type: 'tool_result' }>
      this.emit({
        type: 'tool.output',
        turnId: turn.turnId,
        itemId: r.tool_use_id,
        output: truncateOutput(toolResultText(r.content)),
        isError: r.is_error === true,
        exitCode: null,
        fileChanges: null,
      })
    }
  }

  private onResult(line: Extract<Line, { type: 'result' }>): void {
    const turn = this.turn
    if (!turn) return
    const interrupted = turn.interrupted || line.terminal_reason === 'interrupted'
    const status = interrupted ? 'interrupted' : line.is_error ? 'failed' : 'completed'
    const error = status === 'failed' ? (line.errors?.join('; ') || line.result || line.subtype) : null

    let usage: UsageInfo | null = null
    if (line.usage) {
      const total = typeof line.total_cost_usd === 'number' ? line.total_cost_usd : null
      const cost = total === null ? undefined : Math.max(0, total - this.lastTotalCost)
      if (total !== null) this.lastTotalCost = total
      const contextWindow = Object.values(line.modelUsage ?? {})[0]?.contextWindow
      usage = {
        inputTokens: line.usage.input_tokens ?? 0,
        outputTokens: line.usage.output_tokens ?? 0,
        cachedInputTokens: line.usage.cache_read_input_tokens ?? 0,
        ...(cost !== undefined ? { costUsd: cost } : {}),
        ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
        ...(turn.lastContextUsed !== null ? { contextUsed: turn.lastContextUsed } : {}),
      }
      this.emit({ type: 'usage', turnId: turn.turnId, usage, rateLimits: this.rateLimits })
    }

    this.busy = false
    this.turn = null
    for (const requestId of this.pendingRequests.keys()) {
      this.emit({ type: 'permission.response', turnId: turn.turnId, requestId, decision: 'deny', by: 'system' })
    }
    this.pendingRequests.clear()
    this.emit({ type: 'turn.end', turnId: turn.turnId, status, error, usage, at: nowIso() })
  }

  private onControlRequest(line: Extract<Line, { type: 'control_request' }>): void {
    const req = line.request
    if (req.subtype !== 'can_use_tool') {
      void this.writeLine({
        type: 'control_response',
        response: { subtype: 'error', request_id: line.request_id, error: `unsupported control request: ${req.subtype}` },
      }).catch(() => undefined)
      return
    }
    const turn = this.turn
    const toolName = req.tool_name ?? 'unknown'
    if (!turn) {
      void this.writeLine({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: line.request_id,
          response: { behavior: 'deny', message: 'No turn in progress', interrupt: false },
        },
      }).catch(() => undefined)
      return
    }
    if (toolName === 'AskUserQuestion') {
      const input = (req.input ?? {}) as { questions?: Array<{ question?: string; header?: string; options?: Array<{ label?: string; description?: string }>; multiSelect?: boolean }> }
      const questions: Question[] = (input.questions ?? []).map((q) => ({
        id: questionId(q.question ?? ''),
        question: q.question ?? '',
        options: (q.options ?? []).map((o) => ({ label: o.label ?? '', description: o.description ?? null })),
        multiSelect: q.multiSelect === true,
      }))
      this.pendingRequests.set(line.request_id, { kind: 'question', toolName, input: req.input })
      this.emit({ type: 'question.request', turnId: turn.turnId, requestId: line.request_id, questions, itemId: req.tool_use_id ?? null })
      return
    }
    this.pendingRequests.set(line.request_id, { kind: 'permission', toolName, input: req.input })
    this.emit({
      type: 'permission.request',
      turnId: turn.turnId,
      requestId: line.request_id,
      toolName: normalizeClaudeTool(toolName),
      input: req.input,
      description: req.description ?? null,
      itemId: req.tool_use_id ?? null,
    })
  }
}

// ---- helpers -----------------------------------------------------------------

function mapGet<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key)
  if (v === undefined) {
    v = make()
    map.set(key, v)
  }
  return v
}

function takeBlock(awaiting: OpenBlock[], kind: OpenBlock['kind']): string | null {
  const idx = awaiting.findIndex((b) => b.kind === kind)
  if (idx < 0) return null
  const [block] = awaiting.splice(idx, 1)
  return block?.itemId ?? null
}

/** A block whose `assistant` line arrived before its content_block_stop: the lowest index wins. */
function takeStreaming(streaming: Map<number, OpenBlock>, kind: OpenBlock['kind']): string | null {
  const index = [...streaming.entries()]
    .filter(([, b]) => b.kind === kind)
    .map(([i]) => i)
    .sort((a, b) => a - b)[0]
  if (index === undefined) return null
  const block = streaming.get(index)
  streaming.delete(index)
  return block?.itemId ?? null
}

function contextUsed(u: RawUsage): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
}

function toolResultText(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n')
}

/** Stable id for a Claude question, which the vendor identifies only by its text. */
export function questionId(text: string): string {
  return `q_${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}`
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
