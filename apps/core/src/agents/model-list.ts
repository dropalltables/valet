import crypto from 'node:crypto'
import { z } from 'zod'
import type { AgentProcess, ModelOption, ProcessRunner } from '@valet/shared'
import { errorMessage } from '../logger.js'
import { CodexRpc } from './codex-rpc.js'
import type * as P from './codex-types.js'

/**
 * One-shot model lists from the CLIs, over the same protocols the adapters speak:
 * Claude Code answers a `list_models` control request on stream-json before any
 * user message; Codex answers `model/list` after the app-server handshake. Both
 * exit when stdin closes, so no turn is ever started.
 */

export const MODEL_LIST_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 5_000
const STDERR_KEEP = 4096

export type ModelListOptions = {
  runner: ProcessRunner
  cwd: string
  env: Record<string, string>
  /** Spawn to answer, inclusive. */
  timeoutMs?: number
  executable?: string
}

/** Aliases first, newest tier first; then whatever else the CLI reported, in its order. */
const CLAUDE_ALIAS_ORDER = ['opus', 'sonnet', 'haiku']

const claudeControlResponse = z.object({
  type: z.literal('control_response'),
  response: z.discriminatedUnion('subtype', [
    z.object({ subtype: z.literal('success'), request_id: z.string(), response: z.unknown().optional() }),
    z.object({ subtype: z.literal('error'), request_id: z.string(), error: z.string() }),
  ]),
})
const claudeModels = z.object({
  models: z.array(z.object({ value: z.string().min(1), displayName: z.string().min(1) })),
})
const claudeResult = z.object({ type: z.literal('result'), is_error: z.boolean(), result: z.string().optional() })

export async function listClaudeModels(opts: ModelListOptions): Promise<ModelOption[]> {
  const argv = [opts.executable ?? 'claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  const env = {
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_ERROR_REPORTING: '1',
    TERM: 'xterm-256color',
    ...opts.env,
  }
  const requestId = crypto.randomUUID()
  const raw = await withProcess(opts, 'claude', argv, env, async (proc) => {
    const answer = new Promise<unknown>((resolve, reject) => {
      proc.onStdoutLine((line) => {
        const json = parseJson(line)
        if (json === undefined) return
        const result = claudeResult.safeParse(json)
        if (result.success && result.data.is_error) {
          reject(new Error(`claude list_models: ${result.data.result || 'the CLI reported an error'}`))
          return
        }
        const parsed = claudeControlResponse.safeParse(json)
        if (!parsed.success || parsed.data.response.request_id !== requestId) return
        if (parsed.data.response.subtype === 'error') reject(new Error(`claude list_models: ${parsed.data.response.error}`))
        else resolve(parsed.data.response.response)
      })
    })
    await proc.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'list_models' } })}\n`)
    return answer
  })
  const parsed = claudeModels.safeParse(raw)
  if (!parsed.success) throw new Error(`claude list_models: unexpected response (${firstIssue(parsed.error)})`)
  const rank = (value: string): number => {
    const idx = CLAUDE_ALIAS_ORDER.indexOf(value.replace(/\[.*\]$/, ''))
    return idx === -1 ? CLAUDE_ALIAS_ORDER.length : idx
  }
  // `default` is what the CLI picks without --model; Valet always passes one.
  return parsed.data.models
    .filter((m) => m.value !== 'default')
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m.value) - rank(b.m.value) || a.i - b.i)
    .map(({ m }) => ({ id: m.value, label: m.displayName }))
}

const codexModels = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      displayName: z.string().nullish(),
      hidden: z.boolean().optional(),
      isDefault: z.boolean().optional(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).optional(),
    }),
  ),
})

export async function listCodexModels(opts: ModelListOptions): Promise<ModelOption[]> {
  const argv = [opts.executable ?? 'codex', 'app-server']
  const env = { RUST_LOG: 'error', ...opts.env }
  const raw = await withProcess(opts, 'codex', argv, env, async (proc, remainingMs) => {
    const rpc = new CodexRpc(proc, () => undefined)
    void proc.exited.then(() => rpc.dispose('codex exited'))
    const init: P.InitializeParams = {
      clientInfo: { name: 'valet', title: 'Valet', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }
    await rpc.request('initialize', init, remainingMs())
    await rpc.notify('initialized', {})
    return rpc.request('model/list', { limit: 200, includeHidden: false }, remainingMs())
  })
  const parsed = codexModels.safeParse(raw)
  if (!parsed.success) throw new Error(`codex model/list: unexpected response (${firstIssue(parsed.error)})`)
  return parsed.data.data
    .filter((m) => !m.hidden)
    .map((m) => ({
      id: m.id,
      label: m.displayName || m.id,
      ...(m.supportedReasoningEfforts ? { reasoningEfforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort) } : {}),
      ...(m.isDefault ? { default: true } : {}),
    }))
}

// ---- process lifecycle -----------------------------------------------------------

/**
 * Spawns the CLI, runs `fetch` against it, and always ends the process afterwards.
 * Fails when the CLI exits before answering (with its stderr tail) or when the
 * deadline passes.
 */
async function withProcess<T>(
  opts: ModelListOptions,
  name: string,
  argv: string[],
  env: Record<string, string>,
  fetch: (proc: AgentProcess, remainingMs: () => number) => Promise<T>,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? MODEL_LIST_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const remainingMs = (): number => Math.max(1, deadline - Date.now())
  const proc = await opts.runner.spawn({ argv, cwd: opts.cwd, env })
  let stderrTail = ''
  proc.onStderr((chunk) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_KEEP)
  })
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      fetch(proc, remainingMs),
      proc.exited.then((info) => {
        const tail = stderrTail.trim().split('\n').slice(-3).join(' ')
        throw new Error(`${name} exited with code ${info.code ?? 'null'} before answering${tail ? `: ${tail}` : ''}`)
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name}: no model list within ${Math.round(timeoutMs / 1000)} s`)), remainingMs())
      }),
    ])
  } catch (err) {
    throw err instanceof Error ? err : new Error(errorMessage(err))
  } finally {
    if (timer) clearTimeout(timer)
    await stop(proc)
  }
}

async function stop(proc: AgentProcess): Promise<void> {
  await proc.closeStdin().catch(() => undefined)
  if (await Promise.race([proc.exited.then(() => true), sleep(1000).then(() => false)])) return
  await proc.signal('SIGTERM').catch(() => undefined)
  if (await Promise.race([proc.exited.then(() => true), sleep(STOP_GRACE_MS).then(() => false)])) return
  await proc.signal('SIGKILL').catch(() => undefined)
  await proc.exited
}

function parseJson(line: string): unknown {
  if (!line.trim()) return undefined
  try {
    return JSON.parse(line) as unknown
  } catch {
    return undefined
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  return issue ? `${issue.path.join('.') || '$'}: ${issue.message}` : 'invalid'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
