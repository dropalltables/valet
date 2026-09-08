import { SANDBOX, type RunReply } from '@valet/shared'
import type { ExecSocket, SupervisorClient } from '../docker/supervisor-client.js'
import type { CodexAuthJson } from '../credentials/store.js'
import { withAskpass } from '../git/askpass.js'
import { git, type GitRunner } from '../git/changes.js'

export const ENV_FILE = `${SANDBOX.home}/.valet/env`
const SETUP_SCRIPT = '.valet/setup'
const RESUME_SCRIPT = '.valet/resume'
const CLONE_TIMEOUT_MS = 15 * 60_000
const SETUP_TIMEOUT_MS = 20 * 60_000
const RESUME_WAIT_MS = 10_000

export type LogSink = (level: 'info' | 'warn' | 'error', message: string) => void

/** Git runner bound to the repo checkout; extra env is merged per call. */
export function repoGit(supervisor: SupervisorClient, baseEnv: Record<string, string>, signal?: AbortSignal): GitRunner {
  return (argv, opts) =>
    supervisor.run(
      {
        argv,
        cwd: SANDBOX.repo,
        env: { ...baseEnv, ...(opts?.env ?? {}) },
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      },
      signal,
    )
}

export async function repoExists(supervisor: SupervisorClient): Promise<boolean> {
  const reply = await supervisor.run({ argv: ['git', 'rev-parse', '--git-dir'], cwd: SANDBOX.repo }).catch(() => null)
  return reply?.code === 0
}

export type CloneSource = { kind: 'github'; url: string; token: string | null } | { kind: 'blank'; path: string }

export async function cloneRepo(supervisor: SupervisorClient, source: CloneSource, baseBranch: string, signal?: AbortSignal): Promise<void> {
  await supervisor.run({ argv: ['rm', '-rf', SANDBOX.repo] }, signal)
  await supervisor.fsMkdir(`${SANDBOX.home}/workspace`)
  const clone = async (env: Record<string, string>): Promise<RunReply> => {
    const url = source.kind === 'github' ? source.url : source.path
    return git(
      (argv, opts) =>
        supervisor.run({ argv, cwd: `${SANDBOX.home}/workspace`, env, ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }, signal),
      ['clone', '--branch', baseBranch, url, SANDBOX.repo],
      { timeoutMs: CLONE_TIMEOUT_MS },
    )
  }
  if (source.kind === 'github') await withAskpass(supervisor, source.token, clone)
  else await clone({})
}

export async function prepareBranch(run: GitRunner, branch: string): Promise<void> {
  await git(run, ['config', 'user.name', 'Valet'])
  await git(run, ['config', 'user.email', 'valet@users.noreply.github.com'])
  const exists = await run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (exists.code === 0) await git(run, ['checkout', branch])
  else await git(run, ['checkout', '-b', branch])
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** `KEY='value'` lines, sourceable by sh and readable by dotenv parsers. */
export async function writeEnvFile(supervisor: SupervisorClient, env: Record<string, string>): Promise<void> {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`)
  await supervisor.fsWrite(ENV_FILE, `${lines.join('\n')}\n`, '600')
}

async function isExecutable(supervisor: SupervisorClient, relPath: string): Promise<boolean> {
  const reply = await supervisor.run({ argv: ['test', '-x', relPath], cwd: SANDBOX.repo })
  return reply.code === 0
}

/**
 * Streams a project script's output as log lines. Resolves with the exit code, or
 * null when `timeoutMs` elapsed first (the process keeps running when detached).
 * Aborting `signal` stops the process and throws the signal's reason.
 */
async function runScript(
  exec: ExecSocket,
  relPath: string,
  env: Record<string, string>,
  sink: LogSink,
  opts: { timeoutMs: number; detach: boolean; signal?: AbortSignal },
): Promise<number | null> {
  opts.signal?.throwIfAborted()
  const proc = await exec.spawn({ argv: [`./${relPath}`], cwd: SANDBOX.repo, env, detach: opts.detach })
  proc.onStdoutLine((line) => sink('info', line))
  proc.onStderr((chunk) => {
    for (const line of chunk.split('\n')) if (line.trim()) sink('info', line)
  })
  let timer: NodeJS.Timeout | undefined
  const onAbort = { fn: (): void => undefined }
  try {
    const outcome = await Promise.race([
      proc.exited.then((info) => ({ kind: 'exited' as const, ...info })),
      new Promise<{ kind: 'timeout' }>((r) => {
        timer = setTimeout(() => r({ kind: 'timeout' }), opts.timeoutMs)
      }),
      new Promise<{ kind: 'aborted' }>((r) => {
        onAbort.fn = () => r({ kind: 'aborted' })
        opts.signal?.addEventListener('abort', onAbort.fn, { once: true })
      }),
    ])
    if (outcome.kind === 'aborted') {
      await proc.signal('SIGTERM').catch(() => undefined)
      opts.signal?.throwIfAborted()
    }
    if (outcome.kind === 'timeout') {
      if (!opts.detach) {
        await proc.signal('SIGTERM')
        sink('warn', `${relPath} did not finish within ${Math.round(opts.timeoutMs / 60_000)} minutes and was stopped`)
      }
      return null
    }
    return outcome.kind === 'exited' ? outcome.code : null
  } finally {
    if (timer) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort.fn)
  }
}

export async function runSetup(
  supervisor: SupervisorClient,
  exec: ExecSocket,
  env: Record<string, string>,
  sink: LogSink,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!(await isExecutable(supervisor, SETUP_SCRIPT))) return false
  sink('info', `Running ${SETUP_SCRIPT}`)
  const code = await runScript(exec, SETUP_SCRIPT, env, sink, { timeoutMs: SETUP_TIMEOUT_MS, detach: false, ...(signal ? { signal } : {}) })
  if (code === 0) sink('info', `${SETUP_SCRIPT} finished`)
  else if (code !== null) sink('warn', `${SETUP_SCRIPT} exited with code ${code}`)
  return true
}

export async function runResume(supervisor: SupervisorClient, exec: ExecSocket, env: Record<string, string>, sink: LogSink): Promise<void> {
  if (!(await isExecutable(supervisor, RESUME_SCRIPT))) return
  sink('info', `Running ${RESUME_SCRIPT}`)
  const code = await runScript(exec, RESUME_SCRIPT, env, sink, { timeoutMs: RESUME_WAIT_MS, detach: true })
  if (code !== null && code !== 0) sink('warn', `${RESUME_SCRIPT} exited with code ${code}`)
}

const CODEX_CONFIG = [
  'check_for_update_on_startup = false',
  'cli_auth_credentials_store = "file"',
  '',
  '[analytics]',
  'enabled = false',
  '',
  `[projects."${SANDBOX.repo}"]`,
  'trust_level = "trusted"',
  '',
].join('\n')

export async function writeCodexHome(supervisor: SupervisorClient, authJson: CodexAuthJson | null): Promise<void> {
  await supervisor.fsMkdir(SANDBOX.codexHome)
  await supervisor.fsWrite(`${SANDBOX.codexHome}/config.toml`, CODEX_CONFIG, '600')
  if (authJson) await supervisor.fsWrite(`${SANDBOX.codexHome}/auth.json`, `${JSON.stringify(authJson, null, 2)}\n`, '600')
  else await supervisor.run({ argv: ['rm', '-f', `${SANDBOX.codexHome}/auth.json`] })
}

export async function readCodexAuth(supervisor: SupervisorClient): Promise<CodexAuthJson | null> {
  const raw = await supervisor.fsRead(`${SANDBOX.codexHome}/auth.json`)
  if (!raw) return null
  try {
    return JSON.parse(raw.toString('utf8')) as CodexAuthJson
  } catch {
    return null
  }
}
