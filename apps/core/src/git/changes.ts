import type { ChangedFile, ChangesResponse, DiffStats, RunReply } from '@valet/shared'

/** Runs git inside the sandbox repo; the thread service binds this to the supervisor. */
export type GitRunner = (argv: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<RunReply>

export class GitError extends Error {
  constructor(
    readonly argv: string[],
    readonly reply: RunReply,
  ) {
    super(`git ${argv.slice(1, 3).join(' ')} failed (code ${reply.code ?? 'null'}): ${reply.stderr.trim() || reply.stdout.trim()}`)
  }
}

export async function git(run: GitRunner, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string>; okCodes?: number[] }): Promise<RunReply> {
  const argv = ['git', ...args]
  const reply = await run(argv, opts)
  const ok = opts?.okCodes ?? [0]
  if (reply.code === null || !ok.includes(reply.code)) throw new GitError(argv, reply)
  return reply
}

// ---- pure parsers -------------------------------------------------------------

export type NumstatEntry = { path: string; oldPath: string | null; additions: number; deletions: number }

/**
 * `git diff --numstat -M -z`: entries are `add\tdel\tpath\0`, or for renames
 * `add\tdel\t\0old\0new\0`. Binary files report `-` for both counts.
 */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const entries: NumstatEntry[] = []
  const parts = out.split('\0')
  let i = 0
  while (i < parts.length) {
    const head = parts[i++]
    if (!head) continue
    const [add, del, inlinePath] = head.split('\t')
    const additions = add === '-' || add === undefined ? 0 : Number(add)
    const deletions = del === '-' || del === undefined ? 0 : Number(del)
    if (inlinePath) {
      entries.push({ path: inlinePath, oldPath: null, additions, deletions })
    } else {
      const oldPath = parts[i++] ?? ''
      const newPath = parts[i++] ?? ''
      entries.push({ path: newPath, oldPath, additions, deletions })
    }
  }
  return entries
}

export type PatchChunk = { path: string; oldPath: string | null; status: ChangedFile['status']; patch: string }

function unquoteGitPath(p: string): string {
  if (!p.startsWith('"')) return p
  try {
    return JSON.parse(p) as string
  } catch {
    return p.slice(1, -1)
  }
}

/** Splits `git diff --patch` output into per-file chunks keyed by the new path. */
export function splitPatches(patch: string): PatchChunk[] {
  const chunks: PatchChunk[] = []
  const lines = patch.split('\n')
  let current: string[] | null = null
  const flush = (): void => {
    if (!current) return
    const text = current.join('\n')
    const header = current[0] ?? ''
    let oldPath: string | null = null
    let newPath: string | null = null
    let status: ChangedFile['status'] = 'modified'
    for (const line of current.slice(1, 12)) {
      if (line.startsWith('new file mode')) status = 'added'
      else if (line.startsWith('deleted file mode')) status = 'deleted'
      else if (line.startsWith('rename from ')) {
        status = 'renamed'
        oldPath = unquoteGitPath(line.slice('rename from '.length))
      } else if (line.startsWith('rename to ')) newPath = unquoteGitPath(line.slice('rename to '.length))
      else if (line.startsWith('--- ') && !oldPath && status !== 'added') {
        const p = line.slice(4)
        if (p !== '/dev/null') oldPath = unquoteGitPath(p).replace(/^a\//, '')
      } else if (line.startsWith('+++ ') && !newPath) {
        const p = line.slice(4)
        if (p !== '/dev/null') newPath = unquoteGitPath(p).replace(/^b\//, '')
      }
    }
    if (!newPath || !oldPath) {
      // Binary or mode-only diffs have no ---/+++ lines; fall back to the header.
      const m = /^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?$/.exec(header)
      if (m) {
        if (!oldPath) oldPath = unquoteGitPath(m[1] ?? '')
        if (!newPath) newPath = unquoteGitPath(m[2] ?? '')
      }
    }
    const path = status === 'deleted' ? (oldPath ?? newPath ?? '') : (newPath ?? oldPath ?? '')
    chunks.push({ path, oldPath: status === 'renamed' ? oldPath : null, status, patch: text })
    current = null
  }
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush()
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  flush()
  return chunks
}

export function parseCommits(out: string): ChangesResponse['commits'] {
  return out
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const [sha = '', subject = '', at = ''] = l.split('\0')
      return { sha, subject, at }
    })
}

function countAdditions(patch: string): number {
  let n = 0
  for (const line of patch.split('\n')) if (line.startsWith('+') && !line.startsWith('+++')) n++
  return n
}

// ---- composition ------------------------------------------------------------------

const UNTRACKED_SCRIPT =
  'git ls-files --others --exclude-standard -z | while IFS= read -r -d "" f; do git diff --no-index --patch -- /dev/null "$f"; done; exit 0'

export async function mergeBase(run: GitRunner, baseBranch: string): Promise<string> {
  const ref = `origin/${baseBranch}`
  const reply = await run(['git', 'merge-base', ref, 'HEAD'])
  if (reply.code === 0) return reply.stdout.trim()
  // No common history yet (unborn or unrelated): diff against the base tip.
  const tip = await git(run, ['rev-parse', '--verify', ref])
  return tip.stdout.trim()
}

export async function computeChanges(run: GitRunner, baseBranch: string): Promise<ChangesResponse> {
  const base = await mergeBase(run, baseBranch)
  const [numstat, patch, untracked, log, status] = await Promise.all([
    git(run, ['diff', '--numstat', '-M', '-z', base]),
    git(run, ['diff', '-M', '--patch', '--no-color', base]),
    run(['bash', '-c', UNTRACKED_SCRIPT]),
    git(run, ['log', '--format=%H%x00%s%x00%cI', `${base}..HEAD`]),
    git(run, ['status', '--porcelain']),
  ])

  const stats = new Map(parseNumstatZ(numstat.stdout).map((e) => [e.path, e]))
  const files: ChangedFile[] = []
  for (const chunk of splitPatches(patch.stdout)) {
    const st = stats.get(chunk.path)
    files.push({
      path: chunk.path,
      oldPath: chunk.oldPath ?? st?.oldPath ?? null,
      status: chunk.status,
      additions: st?.additions ?? 0,
      deletions: st?.deletions ?? 0,
      patch: chunk.patch,
    })
  }
  for (const chunk of splitPatches(untracked.stdout)) {
    files.push({
      path: chunk.path,
      oldPath: null,
      status: 'added',
      additions: countAdditions(chunk.patch),
      deletions: 0,
      patch: chunk.patch,
    })
  }

  const totals: DiffStats = files.reduce(
    (acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  )
  return {
    stats: totals,
    files,
    commits: parseCommits(log.stdout),
    dirty: status.stdout.trim().length > 0,
  }
}
