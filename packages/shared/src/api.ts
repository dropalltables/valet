/**
 * HTTP + WebSocket contract between the web app and core.
 *
 * Core serves everything under `/api`. The web app proxies `/api/*` to core
 * (`next.config.ts` rewrites), so the browser only ever talks to one origin.
 *
 * All request/response bodies are JSON. Errors are `{ error: string }` with a 4xx/5xx
 * status. Authentication: when `VALET_PASSWORD` is set, every route except
 * `/api/health` and `/api/auth/*` requires the `valet_session` cookie.
 */

import type {
  AgentKind,
  ChangedFile,
  CredentialKind,
  CredentialStatus,
  DeviceLogin,
  DiffStats,
  FileEntry,
  Health,
  PermissionPolicy,
  Project,
  ProjectEnvVar,
  Settings,
  Thread,
  ThreadStatus,
} from './domain.js'
import type { StoredEvent } from './events.js'

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** POST /api/auth/login */
export type LoginRequest = { password: string }
/** GET /api/auth/session -> { authenticated: boolean, required: boolean } */
export type SessionResponse = { authenticated: boolean; required: boolean }

// ---------------------------------------------------------------------------
// Health / settings / credentials
// ---------------------------------------------------------------------------

/** GET /api/health -> Health (always 200, even when db/docker are down) */
export type HealthResponse = Health

/** GET /api/settings -> Settings ; PUT /api/settings (partial) -> Settings */
export type SettingsResponse = Settings
export type UpdateSettingsRequest = Partial<Settings>

/** GET /api/credentials -> CredentialStatus[] (one per CredentialKind, always all three) */
export type CredentialsResponse = CredentialStatus[]

/**
 * PUT /api/credentials/:kind
 *  claude: { token }  where token is `sk-ant-oat…` (setup-token) or `sk-ant-api…`
 *  codex:  { apiKey } for API-key auth (device login is a separate flow below)
 *  github: { token }  personal access token with `repo` scope (classic) or
 *          Contents+Pull requests+Metadata read/write (fine-grained)
 * -> CredentialStatus
 * DELETE /api/credentials/:kind -> 204
 */
export type PutCredentialRequest = { token?: string; apiKey?: string }

/**
 * POST /api/credentials/codex/device-login -> DeviceLogin (status pending)
 * GET  /api/credentials/codex/device-login/:id -> DeviceLogin
 * Core runs `codex login --device-auth` in a helper sandbox, parses the URL and
 * code, and stores the resulting auth.json when it completes.
 */
export type DeviceLoginResponse = DeviceLogin

/** GET /api/credentials/github/repos?query= -> repos the token can see, most recently pushed first */
export type GitHubRepo = {
  fullName: string
  url: string
  defaultBranch: string
  private: boolean
  description: string | null
  pushedAt: string | null
}
export type GitHubReposResponse = { repos: GitHubRepo[] }

/** GET /api/credentials/github/repos/:owner/:repo/branches -> { branches: string[], defaultBranch } */
export type GitHubBranchesResponse = { branches: string[]; defaultBranch: string }

/** GET /api/agents -> availability and model lists */
export type AgentInfo = {
  id: AgentKind
  label: string
  /** False when no credential is configured. */
  available: boolean
  reason: string | null
  models: Array<{ id: string; label: string }>
  defaultModel: string
}
export type AgentsResponse = { agents: AgentInfo[] }

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** GET /api/projects -> { projects } */
export type ProjectsResponse = { projects: Project[] }

/**
 * POST /api/projects -> Project
 *  github: { source: 'github', repoUrl, defaultBranch?, name? }
 *  blank:  { source: 'blank', name }  (creates an empty bare repo with one initial commit)
 */
export type CreateProjectRequest =
  | { source: 'github'; repoUrl: string; defaultBranch?: string; name?: string }
  | { source: 'blank'; name: string }

/** GET /api/projects/:id -> Project ; PATCH /api/projects/:id { name?, defaultBranch? } ; DELETE -> 204 (fails 409 while threads exist unless ?force=1) */
export type UpdateProjectRequest = { name?: string; defaultBranch?: string }

/** GET /api/projects/:id/env -> { vars } ; PUT /api/projects/:id/env { vars: [{name, value, kind}] } replaces all ; values omitted keep existing */
export type ProjectEnvResponse = { vars: ProjectEnvVar[] }
export type PutProjectEnvRequest = {
  vars: Array<{ name: string; value?: string; kind: 'plain' | 'secret' }>
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export type ThreadListItem = Thread & {
  projectName: string
  diffStats: DiffStats | null
}

/** GET /api/threads?archived=0|1 -> { threads } newest activity first */
export type ThreadsResponse = { threads: ThreadListItem[] }

/**
 * POST /api/threads -> Thread
 * Creates the thread and immediately starts provisioning + the first turn.
 */
export type CreateThreadRequest = {
  projectId: string
  prompt: string
  images?: Array<{ mediaType: string; dataUrl: string }>
  agent: AgentKind
  model: string
  permissions?: PermissionPolicy
  /** Defaults to the project's default branch. */
  baseBranch?: string
}

/** GET /api/threads/:id -> ThreadListItem ; PATCH { title? } ; DELETE -> 204 (removes container and volume) */
export type UpdateThreadRequest = { title?: string }

/**
 * POST /api/threads/:id/messages -> { turnId }
 * `queue` (default) waits for the current turn; `steer` injects into the running
 * turn when the agent supports it (both do), otherwise falls back to queue.
 * Accepted in every MESSAGEABLE status: wakes a paused container, retries an
 * errored thread.
 */
export type SendMessageRequest = {
  text: string
  images?: Array<{ mediaType: string; dataUrl: string }>
  mode?: 'queue' | 'steer'
}
export type SendMessageResponse = { turnId: string }

/** POST /api/threads/:id/interrupt -> 204 (no-op unless running) */
/** POST /api/threads/:id/pause -> Thread (stops the container; no-op unless idle/waiting) */
/** POST /api/threads/:id/wake -> Thread (starts the container without sending a message) */
/** POST /api/threads/:id/archive -> Thread ; POST /api/threads/:id/unarchive -> Thread */

/** POST /api/threads/:id/permissions/:requestId { decision } -> 204 */
export type PermissionDecisionRequest = { decision: 'allow' | 'deny' }
/** POST /api/threads/:id/questions/:requestId { answers } -> 204 */
export type QuestionAnswerRequest = { answers: Record<string, string[]> }

/** GET /api/threads/:id/events?since=<seq>&limit=<n> -> { events, hasMore } (paged replay; the WebSocket below is the live path) */
export type EventsResponse = { events: StoredEvent[]; hasMore: boolean }

/**
 * GET /api/threads/:id/changes -> changes vs `baseBranch` (merge-base), including
 * uncommitted work. Computed inside the sandbox; 409 when the container is paused
 * (`{ error: 'paused' }`) so the UI can offer to wake it.
 */
export type ChangesResponse = {
  stats: DiffStats
  files: ChangedFile[]
  /** Commits on the thread branch not on base, newest first. */
  commits: Array<{ sha: string; subject: string; at: string }>
  /** Whether the working tree has uncommitted changes. */
  dirty: boolean
}

/** GET /api/threads/:id/files?path=<dir> -> { entries } (relative to the repo root; `.git` hidden) */
export type FilesResponse = { path: string; entries: FileEntry[] }
/** GET /api/threads/:id/file?path=<file> -> { path, content, truncated, binary } (content omitted when binary) */
export type FileResponse = { path: string; content: string | null; truncated: boolean; binary: boolean; size: number }

/**
 * POST /api/threads/:id/push -> { branch, pushed: true }
 * Commits any uncommitted work as `valet: <title>` and pushes the thread branch.
 * POST /api/threads/:id/pr { title?, body?, draft? } -> Thread (with `pr` set)
 * Pushes first, then opens the pull request through the GitHub API. 409 when a PR
 * already exists; 400 for blank projects.
 */
export type PushResponse = { branch: string; pushed: true }
export type CreatePrRequest = { title?: string; body?: string; draft?: boolean }

// ---------------------------------------------------------------------------
// WebSockets
// ---------------------------------------------------------------------------

/**
 * WS /api/threads/:id/stream?since=<seq>
 *
 * Server replays persisted events after `since`, then tails live events. Frames
 * are JSON `StreamFrame`s. The client never sends anything except pings.
 */
export type StreamFrame =
  | { t: 'event'; seq: number; event: StoredEvent['event'] }
  /** End of replay; everything after this is live. */
  | { t: 'live' }
  /** Thread row changed (status, pr, title, container). */
  | { t: 'thread'; thread: Thread }
  | { t: 'error'; message: string }

/**
 * WS /api/stream
 *
 * Global feed for the sidebar: thread rows as they change, and project changes.
 */
export type GlobalFrame =
  | { t: 'thread'; thread: ThreadListItem }
  | { t: 'thread.deleted'; id: string }
  | { t: 'project'; project: Project }
  | { t: 'project.deleted'; id: string }

/**
 * WS /api/threads/:id/pty
 *
 * Interactive shell in the sandbox (a shared tmux session, so the agent and the
 * user see the same terminal). Frames are JSON; terminal bytes are base64.
 */
export type PtyClientFrame =
  | { t: 'data'; data: string }
  | { t: 'resize'; cols: number; rows: number }
export type PtyServerFrame = { t: 'data'; data: string } | { t: 'exit'; code: number }

/**
 * WS /api/threads/:id/vnc
 *
 * Binary frames only: a raw RFB (VNC) byte stream for noVNC. Core relays to the
 * sandbox supervisor, which relays to the local VNC server.
 */

/** Statuses for which the container exists and the pty/vnc/changes routes work. */
export const LIVE_STATUSES: ReadonlyArray<ThreadStatus> = ['running', 'waiting', 'idle']
