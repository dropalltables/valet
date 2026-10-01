import { createHash } from 'node:crypto'
import { SANDBOX, type RunReply } from '@valet/shared'
import type { ExecSocket, SupervisorClient } from '../docker/supervisor-client.js'
import type { CodexAuthJson, CredentialStore } from '../credentials/store.js'
import { withAskpass } from '../git/askpass.js'
import { git, type GitRunner } from '../git/changes.js'
import { claudeMcpConfig, codexConfigToml, type ResolvedMcpServer } from '../mcp/config.js'
import { errorMessage } from '../logger.js'

export const ENV_FILE = `${SANDBOX.home}/.valet/env`
const SETUP_SCRIPT = '.valet/setup'
const RESUME_SCRIPT = '.valet/resume'
const CLONE_TIMEOUT_MS = 15 * 60_000
const SETUP_TIMEOUT_MS = 20 * 60_000
const RESUME_WAIT_MS = 10_000
/** `valet services ensure` waits up to a minute per service, in parallel, plus the supervisord round trips. */
const ENSURE_TIMEOUT_MS = 3 * 60_000

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

/**
 * Files whose contents decide whether a snapshot still fits a repository. Anything a
 * `.valet/setup` run would install from; `requirements*.txt` is matched separately.
 */
const SNAPSHOT_LOCKFILES: readonly string[] = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'go.sum',
  'composer.lock',
  'mix.lock',
]

const REQUIREMENTS_RE = /^requirements[\w.-]*\.txt$/

/** The lockfiles to hash, given the names in the repository root, sorted for determinism. */
export function snapshotKeyPaths(rootEntries: readonly string[]): string[] {
  const wanted = new Set(SNAPSHOT_LOCKFILES)
  return rootEntries.filter((name) => wanted.has(name) || REQUIREMENTS_RE.test(name)).sort()
}

/** A hashed path: `null` means it is absent at the ref, which hashes differently from empty. */
export type SnapshotEntry = { path: string; oid: string | null }

/**
 * Blob ids rather than file contents: exact for binary lockfiles such as `bun.lockb`, and
 * unaffected by the cap the supervisor puts on a command's output. The paths are hashed
 * alongside them, so adding or removing a lockfile changes the key on its own.
 */
export function snapshotKey(baseBranch: string, entries: readonly SnapshotEntry[]): string {
  const hash = createHash('sha256')
  hash.update(`base\0${baseBranch}\0`)
  for (const entry of entries) hash.update(`file\0${entry.path}\0${entry.oid ?? 'absent'}\0`)
  return hash.digest('hex')
}

export const shortSnapshotKey = (key: string): string => key.slice(0, 12)

/** Blob ids at `ref`, in the order asked for; a path outside that tree is simply not listed. */
async function blobOids(run: GitRunner, ref: string, paths: readonly string[]): Promise<SnapshotEntry[]> {
  const listed = await git(run, ['ls-tree', '-z', ref, '--', ...paths])
  const oids = new Map<string, string>()
  for (const entry of listed.stdout.split('\0')) {
    const [meta, path] = entry.split('\t')
    const oid = meta?.split(' ')[2]
    if (path && oid) oids.set(path, oid)
  }
  return paths.map((path) => ({ path, oid: oids.get(path) ?? null }))
}

/** The snapshot key of the repository as committed at `ref`. */
export async function readSnapshotKey(run: GitRunner, ref: string, baseBranch: string): Promise<string> {
  const root = await git(run, ['ls-tree', '--name-only', ref])
  const paths = [SETUP_SCRIPT, ...snapshotKeyPaths(root.stdout.split('\n').filter(Boolean))]
  return snapshotKey(baseBranch, await blobOids(run, ref, paths))
}

/**
 * Fetches `baseBranch` into FETCH_HEAD in a repository restored from a snapshot and
 * returns its key there, so the caller can tell whether the snapshot still applies.
 */
export async function fetchBaseKey(
  supervisor: SupervisorClient,
  source: CloneSource,
  baseBranch: string,
  signal?: AbortSignal,
): Promise<string> {
  const run = repoGit(supervisor, {}, signal)
  const fetch = async (env: Record<string, string>): Promise<RunReply> =>
    git((argv, opts) => run(argv, { ...opts, env }), ['fetch', '--force', 'origin', baseBranch], { timeoutMs: CLONE_TIMEOUT_MS })
  if (source.kind === 'github') await withAskpass(supervisor, source.token, fetch)
  else await fetch({})
  return readSnapshotKey(run, 'FETCH_HEAD', baseBranch)
}

/**
 * Puts a restored checkout back where a fresh clone would be: `baseBranch` at the tip
 * just fetched, with the branch of the thread the snapshot was taken from removed.
 * Untracked files (the installed dependencies) survive, which is the point.
 */
export async function resetToFetchHead(run: GitRunner, baseBranch: string): Promise<void> {
  await git(run, ['checkout', '-B', baseBranch])
  await git(run, ['reset', '--hard', 'FETCH_HEAD'])
  const heads = await git(run, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
  for (const branch of heads.stdout.split('\n').filter((b) => b && b !== baseBranch)) {
    await git(run, ['branch', '-D', branch])
  }
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
 * Streams a command's output as log lines. Resolves with the exit code, or null
 * when `timeoutMs` elapsed first (the process keeps running when detached).
 * Aborting `signal` stops the process and throws the signal's reason.
 */
async function runScript(
  exec: ExecSocket,
  argv: string[],
  env: Record<string, string>,
  sink: LogSink,
  opts: { timeoutMs: number; detach: boolean; killGroupOnExit?: boolean; signal?: AbortSignal },
): Promise<number | null> {
  opts.signal?.throwIfAborted()
  const what = argv.join(' ')
  const proc = await exec.spawn({ argv, cwd: SANDBOX.repo, env, detach: opts.detach, ...(opts.killGroupOnExit ? { killGroupOnExit: true } : {}) })
  proc.onStdoutLine((line) => sink('info', line))
  proc.onStderr((chunk) => {
    for (const line of chunk.split('\n')) if (line.trim()) sink(argv[0] === 'valet' ? 'warn' : 'info', line)
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
        sink('warn', `${what} did not finish within ${Math.round(opts.timeoutMs / 60_000)} minutes and was stopped`)
      }
      return null
    }
    return outcome.kind === 'exited' ? outcome.code : null
  } finally {
    if (timer) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort.fn)
  }
}

/** `ran` is whether the repo has a setup script at all; `ok` whether it exited 0. */
export async function runSetup(
  supervisor: SupervisorClient,
  exec: ExecSocket,
  env: Record<string, string>,
  sink: LogSink,
  signal?: AbortSignal,
): Promise<{ ran: boolean; ok: boolean }> {
  if (!(await isExecutable(supervisor, SETUP_SCRIPT))) return { ran: false, ok: false }
  sink('info', `Running ${SETUP_SCRIPT}`)
  // Servers belong in services; whatever setup leaves running in its process group is stopped with it.
  const code = await runScript(exec, [`./${SETUP_SCRIPT}`], env, sink, { timeoutMs: SETUP_TIMEOUT_MS, detach: false, killGroupOnExit: true, ...(signal ? { signal } : {}) })
  if (code === 0) sink('info', `${SETUP_SCRIPT} finished`)
  else if (code !== null) sink('warn', `${SETUP_SCRIPT} exited with code ${code}`)
  return { ran: true, ok: code === 0 }
}

export async function runResume(supervisor: SupervisorClient, exec: ExecSocket, env: Record<string, string>, sink: LogSink): Promise<void> {
  if (!(await isExecutable(supervisor, RESUME_SCRIPT))) return
  sink('info', `Running ${RESUME_SCRIPT}`)
  const code = await runScript(exec, [`./${RESUME_SCRIPT}`], env, sink, { timeoutMs: RESUME_WAIT_MS, detach: true })
  if (code !== null && code !== 0) sink('warn', `${RESUME_SCRIPT} exited with code ${code}`)
}

/**
 * Applies `.valet/services.yaml` through the in-sandbox CLI so the log shows what
 * the agent would see. Failures are warnings: a service that does not come up is
 * the project's problem, not the thread's.
 */
export async function runServicesEnsure(supervisor: SupervisorClient, exec: ExecSocket, sink: LogSink, signal?: AbortSignal): Promise<void> {
  try {
    const declared = await supervisor.run({ argv: ['test', '-f', SANDBOX.servicesYaml] }, signal)
    if (declared.code !== 0) return
    sink('info', 'Running valet services ensure')
    const code = await runScript(exec, ['valet', 'services', 'ensure'], {}, sink, { timeoutMs: ENSURE_TIMEOUT_MS, detach: false, ...(signal ? { signal } : {}) })
    if (code !== null && code !== 0) sink('warn', `valet services ensure exited with code ${code}`)
  } catch (err) {
    signal?.throwIfAborted()
    // A container from an older image has no `valet` CLI; the thread still works without services.
    sink('warn', `valet services ensure failed: ${errorMessage(err)}`)
  }
}

/**
 * The `mcpServers` the repository declares in `.mcp.json`. Claude Code would load
 * them itself, without an approval prompt under `-p`, so Valet reads the file and
 * merges it only when the operator turned that on; the launch always runs with
 * `--strict-mcp-config`.
 */
async function projectMcpServers(supervisor: SupervisorClient, sink: LogSink): Promise<Record<string, unknown>> {
  const raw = await supervisor.fsRead(SANDBOX.projectMcpJson)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as { mcpServers?: Record<string, unknown> }
    return parsed.mcpServers ?? {}
  } catch (err) {
    sink('warn', `ignoring ${SANDBOX.projectMcpJson}: ${errorMessage(err)}`)
    return {}
  }
}

/**
 * Writes the MCP config Claude Code launches with, and returns its path or null
 * when there is nothing to load.
 */
export async function writeClaudeMcpConfig(
  supervisor: SupervisorClient,
  servers: ResolvedMcpServer[],
  allowProjectMcpJson: boolean,
  sink: LogSink,
): Promise<string | null> {
  const fromRepo = allowProjectMcpJson ? await projectMcpServers(supervisor, sink) : {}
  if (servers.length === 0 && Object.keys(fromRepo).length === 0) {
    // A server may have been removed since the last launch; its secrets go with it.
    await supervisor.run({ argv: ['rm', '-f', SANDBOX.mcpConfig] })
    return null
  }
  await supervisor.fsWrite(SANDBOX.mcpConfig, claudeMcpConfig(servers, fromRepo), '600')
  return SANDBOX.mcpConfig
}

export async function writeCodexHome(
  supervisor: SupervisorClient,
  authJson: CodexAuthJson | null,
  mcpServers: ResolvedMcpServer[],
): Promise<void> {
  await supervisor.fsMkdir(SANDBOX.codexHome)
  await supervisor.fsWrite(`${SANDBOX.codexHome}/config.toml`, codexConfigToml(mcpServers), '600')
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

/**
 * Codex rewrites auth.json when it refreshes its tokens, and a rotated refresh
 * token invalidates the stored one; whatever ran codex must copy the result back.
 */
export async function syncCodexAuth(supervisor: SupervisorClient, credentials: CredentialStore, accountId: string | null): Promise<void> {
  if (!accountId) return
  const auth = await credentials.codexAuthFor(accountId)
  if (auth?.mode !== 'oauth') return
  const current = await readCodexAuth(supervisor)
  if (!current?.tokens || !current.last_refresh || current.last_refresh === auth.authJson.last_refresh) return
  await credentials.updateAccountPayload<'codex'>(accountId, { authJson: current })
}
