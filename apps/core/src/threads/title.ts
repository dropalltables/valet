import type { AgentKind, AgentProcess, ModelOption, ProcessRunner } from '@valet/shared'
import { SANDBOX } from '@valet/shared'
import type { SupervisorClient } from '../docker/supervisor-client.js'
import { errorMessage } from '../logger.js'

/** Title generation is cosmetic: give up on a slow model rather than hold anything up. */
export const TITLE_TIMEOUT_MS = 60_000
export const TITLE_MAX_CHARS = 60

const CLAUDE_CHEAPEST = ['haiku', 'sonnet']

/**
 * The cheapest model in a CLI's list. Claude Code reports tier aliases, so the cheapest
 * tier present wins. Codex reports the newest generation first and has no price in its
 * list, so a `nano` or `mini` wins, else the oldest generation listed.
 */
export function cheapestModel(agent: AgentKind, models: ReadonlyArray<ModelOption>): string | null {
  if (models.length === 0) return null
  if (agent === 'claude') {
    const alias = CLAUDE_CHEAPEST.find((a) => models.some((m) => m.id === a))
    return alias ?? models[0]!.id
  }
  const small = models.find((m) => /nano/.test(m.id)) ?? models.find((m) => /mini/.test(m.id))
  return small?.id ?? models[models.length - 1]!.id
}

/** One line, no wrapping quotes or trailing period, at most `TITLE_MAX_CHARS`; null when nothing usable came back. */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  const stripped = line.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').replace(/[.。]+$/, '').replace(/\s+/g, ' ').trim()
  if (!stripped) return null
  return stripped.length > TITLE_MAX_CHARS ? `${stripped.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : stripped
}

export function titlePrompt(task: string): string {
  return `Reply with only a title for this coding task: at most six words, no quotes, no trailing period.\n\n${task}`
}

export type GenerateTitleOptions = {
  runner: ProcessRunner
  supervisor: SupervisorClient
  agent: AgentKind
  model: string
  env: Record<string, string>
  task: string
  threadId: string
}

/** Asks the CLI inside the thread's own sandbox, under the thread's account, for a title. */
export async function generateTitle(opts: GenerateTitleOptions): Promise<string | null> {
  const prompt = titlePrompt(opts.task)
  if (opts.agent === 'claude') {
    const argv = ['claude', '-p', '--model', opts.model, '--output-format', 'text', '--no-session-persistence', prompt]
    const env = { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_ERROR_REPORTING: '1', ...opts.env }
    return cleanTitle(await runToExit(opts.runner, argv, env))
  }
  const out = `/tmp/valet-title-${opts.threadId}`
  const argv = ['codex', 'exec', '-m', opts.model, '--skip-git-repo-check', '--ephemeral', '-o', out, prompt]
  await runToExit(opts.runner, argv, { RUST_LOG: 'error', ...opts.env })
  const raw = await opts.supervisor.fsRead(out)
  return raw ? cleanTitle(raw.toString('utf8')) : null
}

/** Stdout of a process that must finish within `TITLE_TIMEOUT_MS`; its stderr tail is the error when it does not succeed. */
async function runToExit(runner: ProcessRunner, argv: string[], env: Record<string, string>): Promise<string> {
  const proc: AgentProcess = await runner.spawn({ argv, cwd: SANDBOX.home, env })
  let stdout = ''
  let stderr = ''
  proc.onStdoutLine((line) => {
    stdout += `${line}\n`
  })
  proc.onStderr((chunk) => {
    stderr = (stderr + chunk).slice(-2048)
  })
  await proc.closeStdin().catch(() => undefined)
  let timer: NodeJS.Timeout | null = null
  try {
    const info = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${argv[0]}: no title within ${TITLE_TIMEOUT_MS / 1000} s`)), TITLE_TIMEOUT_MS)
      }),
    ])
    if (info.code !== 0) throw new Error(`${argv[0]} exited with code ${info.code ?? 'null'}: ${stderr.trim().split('\n').slice(-2).join(' ')}`)
    return stdout
  } catch (err) {
    await proc.signal('SIGKILL').catch(() => undefined)
    throw err instanceof Error ? err : new Error(errorMessage(err))
  } finally {
    if (timer) clearTimeout(timer)
  }
}
