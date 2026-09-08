/**
 * Domain model shared by core (persists it), web (renders it), and the sandbox
 * supervisor (never sees it, but the ids appear in container labels).
 *
 * Everything here is JSON: dates are ISO strings, ids are opaque strings.
 */

/** Which coding agent runs inside the sandbox. */
export type AgentKind = 'claude' | 'codex'

export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

/** One selectable model, as the CLI reports it (see the model catalog in core). */
export type ModelOption = {
  /** What `--model` accepts: a Claude alias (`opus`), or a Codex model id (`gpt-6-astra`). */
  id: string
  label: string
  /** Codex only: reasoning efforts the model supports. */
  reasoningEfforts?: string[]
  /** Codex only: the model the CLI would pick on its own. */
  default?: boolean
}

/**
 * Fallback model lists, shown until core has asked the CLIs (`claude` answers a
 * `list_models` control request, `codex app-server` a `model/list` request) with the
 * stored credential, and whenever that failed.
 *
 * Claude Code accepts the aliases `opus`, `sonnet`, `haiku`, which resolve to the
 * newest model of that tier; sending an alias is safer than pinning a dated id.
 */
export const DEFAULT_MODELS: Record<AgentKind, ReadonlyArray<ModelOption>> = {
  claude: [
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
  ],
  codex: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ],
}

export const DEFAULT_MODEL: Record<AgentKind, string> = {
  claude: 'opus',
  codex: 'gpt-6-astra',
}

/**
 * How the agent's tool use is gated.
 *
 * `auto`: no prompts; the container is the sandbox (Claude `bypassPermissions`,
 * Codex `approvalPolicy: never` + `dangerFullAccess`).
 * `ask`: edits are auto-approved, everything else asks; the question surfaces in the
 * transcript as a `permission.request` event and the thread goes to `waiting`.
 */
export type PermissionPolicy = 'auto' | 'ask'

/**
 * Thread lifecycle.
 *
 * provisioning: container being created, repo cloned, `.valet/setup` running.
 * running:      a turn is in progress.
 * waiting:      the agent asked a question or needs a permission decision.
 * idle:         container up, no turn in progress; idle timer counts down to `paused`.
 * paused:       container stopped (`docker stop`); disk state intact; wakes on message.
 * error:        provisioning or the last turn failed; sending a message retries.
 * archived:     container removed; transcript read-only; volume kept until deleted.
 */
export type ThreadStatus =
  | 'provisioning'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'paused'
  | 'error'
  | 'archived'

/** Statuses in which a message can be accepted (it wakes/retries as needed). */
export const MESSAGEABLE_STATUSES: ReadonlyArray<ThreadStatus> = [
  'running',
  'waiting',
  'idle',
  'paused',
  'error',
]

export type ProjectSource = 'github' | 'blank'

export type Project = {
  id: string
  name: string
  source: ProjectSource
  /**
   * `github`: `https://github.com/<owner>/<repo>` (no `.git`, no trailing slash).
   * `blank`: null; the bare repo lives at `/valet/repos/<id>.git` on the shared
   * `valet-repos` volume and sandboxes clone it over the file protocol.
   */
  repoUrl: string | null
  /** Branch new threads start from. */
  defaultBranch: string
  /** Whether the repo has a `.valet/setup` script (detected on first clone). */
  hasSetupScript: boolean | null
  createdAt: string
  updatedAt: string
}

/** Per-project environment variables. Values are encrypted at rest; the API returns them masked. */
export type ProjectEnvVar = {
  name: string
  /** Masked for display, e.g. `sk-…9f2a`. Never the full value. */
  maskedValue: string
  /** `secret` values are hidden in the transcript and terminal are still able to read them. */
  kind: 'plain' | 'secret'
}

export type PullRequestState = 'open' | 'merged' | 'closed'

export type Thread = {
  id: string
  projectId: string
  /** Derived from the first prompt; renameable. */
  title: string
  agent: AgentKind
  model: string
  permissions: PermissionPolicy
  status: ThreadStatus
  /** Human-readable reason when `status === 'error'`. */
  error: string | null
  /** `valet/<slug>-<4hex>`, created from `baseBranch` on first provision. */
  branch: string
  baseBranch: string
  /** Docker container id while one exists (idle, running, waiting, paused). */
  containerId: string | null
  /** Agent-side session id (Claude session uuid / Codex thread id) once a turn has run. */
  agentSessionId: string | null
  pr: { url: string; number: number; state: PullRequestState } | null
  /** Aggregate cost in USD as estimated by the agent; null when unknown. */
  costUsd: number | null
  /** Last event of any kind; drives the idle timer and list ordering. */
  lastActivityAt: string
  createdAt: string
  archivedAt: string | null
}

/**
 * A TCP port listening inside the sandbox, reachable from the browser at `url`
 * through the portal proxy (`t-<thread>-p<port>.<VALET_PORTAL_DOMAIN>`).
 */
export type Portal = {
  port: number
  /** From the repo's `.valet/ports.json` (`{ "3000": "web" }`) when present. */
  name: string | null
  /** Listening process (argv[0] basename), when readable. */
  process: string | null
  /** Browser-facing origin, e.g. `http://t-<thread>-p3000.localhost:3000`. */
  url: string
  /** Expiry of the active share link for this port, or null when none is active. */
  shareExpiresAt: string | null
}

/** Portal hostnames: `t-<threadId>-p<port>.<domain>`. Thread ids are lowercase alphanumerics (see core `ids.ts`). */
export const PORTAL_HOST_RE = /^t-([a-z0-9]+)-p(\d+)\./

/**
 * Domain portal hosts live under: `VALET_PORTAL_DOMAIN`, or the host[:port] of
 * `VALET_BASE_URL`. Core and the web app must agree, so both derive it from here.
 */
export function portalDomain(env: { VALET_PORTAL_DOMAIN?: string | undefined; VALET_BASE_URL?: string | undefined }): string {
  const explicit = env.VALET_PORTAL_DOMAIN?.trim().toLowerCase()
  if (explicit) return explicit
  return new URL(env.VALET_BASE_URL?.trim() || 'http://localhost:3000').host.toLowerCase()
}

export function portalHost(threadId: string, port: number, domain: string): string {
  return `t-${threadId}-p${port}.${domain}`
}

/**
 * Thread and port of a browser-facing host under `domain`, or null for any other
 * host. `host` may carry a port (`t-abc-p3000.localhost:3000`).
 */
export function parsePortalHost(host: string, domain: string): { threadId: string; port: number } | null {
  const lower = host.toLowerCase()
  const m = PORTAL_HOST_RE.exec(lower)
  if (!m || !m[1] || !m[2]) return null
  const port = Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (lower !== portalHost(m[1], port, domain)) return null
  return { threadId: m[1], port }
}

/** Summary counts shown next to a thread: `+12 -3` across 4 files. */
export type DiffStats = {
  files: number
  additions: number
  deletions: number
}

export type ChangedFile = {
  path: string
  /** Rename source when `status === 'renamed'`. */
  oldPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  /** Unified diff for this file only, including the `diff --git` header. */
  patch: string
}

export type FileEntry = {
  name: string
  path: string
  kind: 'file' | 'dir'
  size: number | null
}

/**
 * Credentials live in the database, encrypted with `VALET_SECRET_KEY`. The API
 * only ever reports whether one exists plus a masked hint.
 */
export type CredentialKind =
  /** `claude setup-token` output (`sk-ant-oat…`) or an Anthropic API key (`sk-ant-api…`). */
  | 'claude'
  /** Codex `auth.json` captured from a device-code login, or an OpenAI API key. */
  | 'codex'
  /** GitHub personal access token used for clone, push, and pull requests. */
  | 'github'

export type CredentialStatus = {
  kind: CredentialKind
  configured: boolean
  /** e.g. `sk-ant-oat…3f9a`, `ChatGPT (you@example.com)`, `ghp_…a1b2`. */
  label: string | null
  /** For `claude`/`codex`: `oauth` (subscription) or `api-key`. */
  method: 'oauth' | 'api-key' | null
  updatedAt: string | null
}

/** Device-code login for Codex (`codex login --device-auth`) run inside a helper sandbox. */
export type DeviceLogin = {
  id: string
  status: 'pending' | 'complete' | 'failed' | 'expired'
  /** Where the user goes to enter the code. */
  verificationUrl: string
  userCode: string
  error: string | null
}

export type SandboxImageStatus = {
  image: string
  present: boolean
  /** Docker image id when present. */
  imageId: string | null
  createdAt: string | null
}

export type Health = {
  ok: boolean
  version: string
  db: { ok: boolean; error: string | null }
  docker: { ok: boolean; error: string | null }
  sandboxImage: SandboxImageStatus
  /** Whether `VALET_PASSWORD` is set; the UI shows a login screen when true. */
  authEnabled: boolean
}

export type Settings = {
  /** Minutes of inactivity before an idle container is stopped. */
  idlePauseMinutes: number
  defaultAgent: AgentKind
  defaultModel: Record<AgentKind, string>
  defaultPermissions: PermissionPolicy
}

/** Slug for branch names and container names: lowercase, hyphens, max 40 chars. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'thread'
  )
}

/** Sandbox-side filesystem layout. Fixed so every component can rely on it. */
export const SANDBOX = {
  user: 'valet',
  uid: 1000,
  home: '/home/valet',
  /** The project checkout; the agent's cwd. */
  repo: '/home/valet/workspace/repo',
  claudeConfigDir: '/home/valet/.claude',
  codexHome: '/home/valet/.codex',
  /** Bare repos for `blank` projects, mounted from the `valet-repos` volume. */
  reposMount: '/valet/repos',
  /** Supervisor HTTP/WS port inside the container. */
  supervisorPort: 9500,
  /** VNC server port (localhost only) the supervisor relays to `/vnc`. */
  vncPort: 5901,
  /** Optional port names for portals, committed to the repo: `{ "3000": "web", "8000": "api" }`. */
  portsFile: '/home/valet/workspace/repo/.valet/ports.json',
  display: ':1',
} as const
