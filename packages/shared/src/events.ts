/**
 * Transcript events.
 *
 * Core normalizes whatever the agent CLI emits (Claude Code stream-json, Codex
 * app-server JSON-RPC) into this one event vocabulary, appends each event to
 * `thread_events` with a monotonic `seq`, and fans it out to subscribers. The web
 * app never sees vendor formats.
 *
 * Deltas are persisted too, coalesced by core (at most a few rows per second per
 * item), so replaying from `seq = 0` and tailing live produce identical results and
 * the UI needs exactly one reducer: `reduceEvents`.
 */

import type { ThreadStatus } from './domain.js'

export type UsageInfo = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  /** Agent-reported estimate in USD for the turn, when available. */
  costUsd?: number
  /** Context window size and current usage, when the agent reports it. */
  contextWindow?: number
  contextUsed?: number
}

export type RateLimitInfo = {
  /** e.g. `five_hour`, `seven_day`, `codex` */
  window: string
  /** 0..1 */
  utilization: number
  resetsAt: string | null
}

export type PermissionSuggestion = { label: string; value: string }

export type Question = {
  id: string
  question: string
  options: Array<{ label: string; description: string | null }>
  multiSelect: boolean
}

export type FileChange = {
  path: string
  kind: 'add' | 'update' | 'delete' | 'rename'
  /** Unified diff for this file when the agent supplies one. */
  diff: string | null
}

/**
 * Every event carries the `turnId` of the turn it belongs to, except events that
 * are about the thread as a whole (`status`, `log`, `error` without a turn).
 *
 * `itemId` identifies one block inside a turn (a text block, a reasoning block, a
 * tool call). Deltas for the same item share an id; the item is complete when its
 * `*.end` / `tool.output` event arrives.
 */
export type ThreadEvent =
  // ---- turn boundaries -----------------------------------------------------
  | {
      type: 'turn.start'
      turnId: string
      /** What the user sent. Rendered as the user message. */
      prompt: { text: string; images: Array<{ mediaType: string; dataUrl: string }> }
      /** `steer` prompts were injected mid-turn; render them inline, not as a new turn. */
      mode: 'queue' | 'steer'
      at: string
    }
  | {
      type: 'turn.end'
      turnId: string
      status: 'completed' | 'interrupted' | 'failed'
      error: string | null
      usage: UsageInfo | null
      at: string
    }
  // ---- assistant output ----------------------------------------------------
  | { type: 'text.delta'; turnId: string; itemId: string; delta: string }
  | { type: 'text.end'; turnId: string; itemId: string; text: string }
  | { type: 'reasoning.delta'; turnId: string; itemId: string; delta: string }
  | { type: 'reasoning.end'; turnId: string; itemId: string; text: string }
  // ---- tool calls ----------------------------------------------------------
  | {
      type: 'tool.start'
      turnId: string
      itemId: string
      /** Normalized name: `bash`, `read`, `write`, `edit`, `grep`, `glob`, `web_search`, `web_fetch`, `todo`, `task`, `mcp:<server>:<tool>`, or the vendor name when unknown. */
      name: string
      /** Vendor tool name, e.g. `Bash`, `command_execution`. */
      vendorName: string
      /** Complete input when known at start, else partial/empty. */
      input: unknown
      /** One-line summary for the collapsed row, e.g. `$ npm test`, `Edited src/a.ts`. */
      title: string
      /** Non-null for subagent activity nested under a parent tool call. */
      parentItemId: string | null
    }
  | { type: 'tool.input'; turnId: string; itemId: string; input: unknown; title: string }
  /** Streaming command output (Codex `outputDelta`, Claude background tasks). */
  | { type: 'tool.outputDelta'; turnId: string; itemId: string; delta: string }
  | {
      type: 'tool.output'
      turnId: string
      itemId: string
      /** Text output (may be truncated by core at 200 KB with a marker). */
      output: string
      isError: boolean
      exitCode: number | null
      /** File edits the tool produced, when the vendor reports them structurally. */
      fileChanges: FileChange[] | null
    }
  // ---- human-in-the-loop ---------------------------------------------------
  | {
      type: 'permission.request'
      turnId: string
      requestId: string
      /** Tool the agent wants to run. */
      toolName: string
      input: unknown
      /** One-line description from the agent, if any. */
      description: string | null
      /** Related tool item when the vendor links them. */
      itemId: string | null
    }
  | {
      type: 'permission.response'
      turnId: string
      requestId: string
      decision: 'allow' | 'deny'
      /** Who decided: the user, or core (timeout, thread archived). */
      by: 'user' | 'system'
    }
  | { type: 'question.request'; turnId: string; requestId: string; questions: Question[]; itemId: string | null }
  | {
      type: 'question.response'
      turnId: string
      requestId: string
      /** question id -> selected labels (or free text) */
      answers: Record<string, string[]>
    }
  // ---- thread-level --------------------------------------------------------
  | { type: 'status'; status: ThreadStatus; detail: string | null; at: string }
  /** Provisioning output and other operator-facing lines (clone, setup script, wake). */
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: string }
  | { type: 'usage'; turnId: string | null; usage: UsageInfo; rateLimits: RateLimitInfo[] | null }
  | { type: 'error'; turnId: string | null; message: string; at: string }
  /** Agent session identity, so the UI can show it and core can resume. */
  | { type: 'session'; agentSessionId: string }

export type ThreadEventType = ThreadEvent['type']

/** An event as stored and streamed: with its position in the thread's log. */
export type StoredEvent = { seq: number; event: ThreadEvent }

// ---------------------------------------------------------------------------
// Reducer: events -> transcript
// ---------------------------------------------------------------------------

export type TextItem = { kind: 'text'; id: string; text: string; done: boolean }
export type ReasoningItem = { kind: 'reasoning'; id: string; text: string; done: boolean }
export type ToolItem = {
  kind: 'tool'
  id: string
  name: string
  vendorName: string
  title: string
  input: unknown
  /** Live output while running (from `tool.outputDelta`) or final output. */
  output: string
  isError: boolean
  exitCode: number | null
  fileChanges: FileChange[] | null
  state: 'running' | 'done' | 'error'
  parentItemId: string | null
  /** Permission request tied to this tool call, if any. */
  permissionRequestId: string | null
}
export type PermissionItem = {
  kind: 'permission'
  id: string
  toolName: string
  input: unknown
  description: string | null
  decision: 'allow' | 'deny' | null
  by: 'user' | 'system' | null
}
export type QuestionItem = {
  kind: 'question'
  id: string
  questions: Question[]
  answers: Record<string, string[]> | null
}
export type SteerItem = { kind: 'steer'; id: string; text: string; at: string }
export type ErrorItem = { kind: 'error'; id: string; message: string }

export type TurnItem = TextItem | ReasoningItem | ToolItem | PermissionItem | QuestionItem | SteerItem | ErrorItem

export type Turn = {
  id: string
  prompt: { text: string; images: Array<{ mediaType: string; dataUrl: string }> }
  startedAt: string
  endedAt: string | null
  status: 'running' | 'completed' | 'interrupted' | 'failed'
  error: string | null
  usage: UsageInfo | null
  items: TurnItem[]
}

export type LogLine = { seq: number; level: 'info' | 'warn' | 'error'; message: string; at: string }

export type Transcript = {
  turns: Turn[]
  /** Provisioning and operational log lines, in order. */
  logs: LogLine[]
  /** Last known status from a `status` event (the Thread row is authoritative). */
  status: ThreadStatus | null
  statusDetail: string | null
  agentSessionId: string | null
  totalCostUsd: number
  lastUsage: UsageInfo | null
  rateLimits: RateLimitInfo[] | null
  /** Highest `seq` applied; pass as `since` when reconnecting. */
  seq: number
}

export function emptyTranscript(): Transcript {
  return {
    turns: [],
    logs: [],
    status: null,
    statusDetail: null,
    agentSessionId: null,
    totalCostUsd: 0,
    lastUsage: null,
    rateLimits: null,
    seq: 0,
  }
}

function findTurn(t: Transcript, turnId: string): Turn | undefined {
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const turn = t.turns[i]
    if (turn && turn.id === turnId) return turn
  }
  return undefined
}

function findItem<K extends TurnItem['kind']>(
  turn: Turn,
  id: string,
  kind: K,
): Extract<TurnItem, { kind: K }> | undefined {
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const it = turn.items[i]
    if (it && it.id === id && it.kind === kind) return it as Extract<TurnItem, { kind: K }>
  }
  return undefined
}

/**
 * Pure and immutable: returns a new Transcript, never mutates `prev`.
 *
 * Tolerant of events for unknown turns/items (creates placeholders) so a UI that
 * subscribes mid-turn still renders something sensible.
 */
export function reduceEvent(prev: Transcript, stored: StoredEvent): Transcript {
  const { seq, event } = stored
  if (seq <= prev.seq) return prev
  const t: Transcript = { ...prev, turns: prev.turns.slice(), logs: prev.logs, seq }

  const turnFor = (turnId: string): Turn => {
    const existing = findTurn(t, turnId)
    if (existing) {
      const copy: Turn = { ...existing, items: existing.items.slice() }
      t.turns[t.turns.indexOf(existing)] = copy
      return copy
    }
    const created: Turn = {
      id: turnId,
      prompt: { text: '', images: [] },
      startedAt: '',
      endedAt: null,
      status: 'running',
      error: null,
      usage: null,
      items: [],
    }
    t.turns.push(created)
    return created
  }

  const replaceItem = (turn: Turn, item: TurnItem): void => {
    const idx = turn.items.findIndex((i) => i.id === item.id && i.kind === item.kind)
    if (idx >= 0) turn.items[idx] = item
    else turn.items.push(item)
  }

  switch (event.type) {
    case 'turn.start': {
      if (event.mode === 'steer') {
        // Attach to the running turn, or the latest turn if none is running.
        const running = [...t.turns].reverse().find((x) => x.status === 'running') ?? t.turns[t.turns.length - 1]
        if (running) {
          const turn = turnFor(running.id)
          turn.items.push({ kind: 'steer', id: event.turnId, text: event.prompt.text, at: event.at })
          return t
        }
      }
      const turn = turnFor(event.turnId)
      turn.prompt = event.prompt
      turn.startedAt = event.at
      turn.status = 'running'
      return t
    }
    case 'turn.end': {
      const turn = turnFor(event.turnId)
      turn.status = event.status
      turn.endedAt = event.at
      turn.error = event.error
      turn.usage = event.usage
      if (event.usage?.costUsd) t.totalCostUsd = prev.totalCostUsd + event.usage.costUsd
      // Anything still streaming is finished now.
      turn.items = turn.items.map((it) => {
        if ((it.kind === 'text' || it.kind === 'reasoning') && !it.done) return { ...it, done: true }
        if (it.kind === 'tool' && it.state === 'running') {
          return { ...it, state: event.status === 'completed' ? 'done' : 'error' }
        }
        return it
      })
      return t
    }
    case 'text.delta': {
      const turn = turnFor(event.turnId)
      const cur = findItem(turn, event.itemId, 'text')
      replaceItem(turn, { kind: 'text', id: event.itemId, text: (cur?.text ?? '') + event.delta, done: false })
      return t
    }
    case 'text.end': {
      const turn = turnFor(event.turnId)
      replaceItem(turn, { kind: 'text', id: event.itemId, text: event.text, done: true })
      return t
    }
    case 'reasoning.delta': {
      const turn = turnFor(event.turnId)
      const cur = findItem(turn, event.itemId, 'reasoning')
      replaceItem(turn, {
        kind: 'reasoning',
        id: event.itemId,
        text: (cur?.text ?? '') + event.delta,
        done: false,
      })
      return t
    }
    case 'reasoning.end': {
      const turn = turnFor(event.turnId)
      replaceItem(turn, { kind: 'reasoning', id: event.itemId, text: event.text, done: true })
      return t
    }
    case 'tool.start': {
      const turn = turnFor(event.turnId)
      replaceItem(turn, {
        kind: 'tool',
        id: event.itemId,
        name: event.name,
        vendorName: event.vendorName,
        title: event.title,
        input: event.input,
        output: '',
        isError: false,
        exitCode: null,
        fileChanges: null,
        state: 'running',
        parentItemId: event.parentItemId,
        permissionRequestId: null,
      })
      return t
    }
    case 'tool.input': {
      const turn = turnFor(event.turnId)
      const cur = findItem(turn, event.itemId, 'tool')
      if (!cur) return t
      replaceItem(turn, { ...cur, input: event.input, title: event.title })
      return t
    }
    case 'tool.outputDelta': {
      const turn = turnFor(event.turnId)
      const cur = findItem(turn, event.itemId, 'tool')
      if (!cur) return t
      replaceItem(turn, { ...cur, output: cur.output + event.delta })
      return t
    }
    case 'tool.output': {
      const turn = turnFor(event.turnId)
      const cur = findItem(turn, event.itemId, 'tool')
      const base: ToolItem = cur ?? {
        kind: 'tool',
        id: event.itemId,
        name: 'unknown',
        vendorName: 'unknown',
        title: '',
        input: null,
        output: '',
        isError: false,
        exitCode: null,
        fileChanges: null,
        state: 'running',
        parentItemId: null,
        permissionRequestId: null,
      }
      replaceItem(turn, {
        ...base,
        output: event.output,
        isError: event.isError,
        exitCode: event.exitCode,
        fileChanges: event.fileChanges,
        state: event.isError ? 'error' : 'done',
      })
      return t
    }
    case 'permission.request': {
      const turn = turnFor(event.turnId)
      replaceItem(turn, {
        kind: 'permission',
        id: event.requestId,
        toolName: event.toolName,
        input: event.input,
        description: event.description,
        decision: null,
        by: null,
      })
      if (event.itemId) {
        const tool = findItem(turn, event.itemId, 'tool')
        if (tool) replaceItem(turn, { ...tool, permissionRequestId: event.requestId })
      }
      return t
    }
    case 'permission.response': {
      const turn = turnFor(event.turnId)
      const cur = findItem(turn, event.requestId, 'permission')
      if (!cur) return t
      replaceItem(turn, { ...cur, decision: event.decision, by: event.by })
      return t
    }
    case 'question.request': {
      const turn = turnFor(event.turnId)
      replaceItem(turn, { kind: 'question', id: event.requestId, questions: event.questions, answers: null })
      return t
    }
    case 'question.response': {
      const turn = turnFor(event.turnId)
      const cur = findItem(turn, event.requestId, 'question')
      if (!cur) return t
      replaceItem(turn, { ...cur, answers: event.answers })
      return t
    }
    case 'status': {
      t.status = event.status
      t.statusDetail = event.detail
      return t
    }
    case 'log': {
      t.logs = [...prev.logs, { seq, level: event.level, message: event.message, at: event.at }]
      return t
    }
    case 'usage': {
      t.lastUsage = event.usage
      if (event.rateLimits) t.rateLimits = event.rateLimits
      return t
    }
    case 'error': {
      if (event.turnId) {
        const turn = turnFor(event.turnId)
        turn.items.push({ kind: 'error', id: `err-${seq}`, message: event.message })
      } else {
        t.logs = [...prev.logs, { seq, level: 'error', message: event.message, at: event.at }]
      }
      return t
    }
    case 'session': {
      t.agentSessionId = event.agentSessionId
      return t
    }
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

export function reduceEvents(prev: Transcript, events: StoredEvent[]): Transcript {
  let t = prev
  for (const e of events) t = reduceEvent(t, e)
  return t
}

/** Final assistant text of the latest completed turn, for titles and PR bodies. */
export function lastAssistantText(t: Transcript): string | null {
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const turn = t.turns[i]
    if (!turn) continue
    for (let j = turn.items.length - 1; j >= 0; j--) {
      const it = turn.items[j]
      if (it && it.kind === 'text' && it.text.trim()) return it.text
    }
  }
  return null
}

/** Human summary for a tool row, used by both adapters so titles look the same. */
export function toolTitle(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string): string | null => (typeof i[k] === 'string' ? (i[k] as string) : null)
  switch (name) {
    case 'bash':
      return `$ ${str('command') ?? ''}`.trim()
    case 'read':
      return `Read ${str('file_path') ?? str('path') ?? ''}`.trim()
    case 'write':
      return `Wrote ${str('file_path') ?? str('path') ?? ''}`.trim()
    case 'edit':
      return `Edited ${str('file_path') ?? str('path') ?? ''}`.trim()
    case 'grep':
      return `Searched ${str('pattern') ?? ''}`.trim()
    case 'glob':
      return `Listed ${str('pattern') ?? ''}`.trim()
    case 'web_search':
      return `Searched the web for ${str('query') ?? ''}`.trim()
    case 'web_fetch':
      return `Fetched ${str('url') ?? ''}`.trim()
    case 'todo':
      return 'Updated tasks'
    case 'task':
      return `Subagent: ${str('description') ?? str('prompt')?.slice(0, 60) ?? ''}`.trim()
    default:
      return name
  }
}
