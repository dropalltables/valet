/**
 * HTTP + WebSocket contract between the web app and core.
 *
 * Core serves everything under `/api`. The web app proxies `/api/*` to core
 * (`next.config.ts` rewrites), so the browser only ever talks to one origin.
 *
 * All request/response bodies are JSON. Errors are `{ error: string }` with a 4xx/5xx
 * status. Authentication: when `VALET_PASSWORD` is set, every route except
 * `/api/health`, `/api/auth/*`, `/api/portal-auth`, and `/api/share/*` (unlisted
 * links, where the token is the credential) requires the `valet_session` cookie.
 *
 * Portals (see the Portals section below) are the exception to "everything under
 * `/api`": requests whose Host is `t-<thread>-p<port>.<VALET_PORTAL_DOMAIN>` are
 * rewritten by the web app to core's `/portal/<thread>/<port><path>` and proxied
 * into the sandbox.
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
  McpServer,
  McpServerScope,
  ModelOption,
  NotificationEvent,
  NotificationSettings,
  PermissionPolicy,
  Portal,
  Project,
  ProjectEnvVar,
  SandboxUsage,
  Service,
  ServiceReadiness,
  Settings,
  Thread,
  ThreadStatus,
  WebhookKind,
} from './domain.js'
import type { RateLimitInfo, StoredEvent } from './events.js'
import type { CreateServiceRequest } from './supervisor.js'

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

/** GET /api/credentials -> CredentialStatus[] (one per CredentialKind, always all of them) */
export type CredentialsResponse = CredentialStatus[]

/**
 * PUT /api/credentials/:kind
 *  claude:     { token }  where token is `sk-ant-oat…` (setup-token) or `sk-ant-api…`
 *  codex:      { apiKey } for API-key auth (device login is a separate flow below)
 *  github:     { token }  personal access token with `repo` scope (classic) or
 *              Contents+Pull requests+Metadata read/write (fine-grained)
 *  github-app: { appId, privateKey, webhookSecret } from the GitHub App's settings page
 * -> CredentialStatus
 * DELETE /api/credentials/:kind -> 204
 */
export type PutCredentialRequest = {
  token?: string
  apiKey?: string
  appId?: number
  privateKey?: string
  webhookSecret?: string
}

/**
 * GET /api/credentials/github/app -> where the App's webhook must point and which
 * accounts have installed it (read from GitHub with the App's own JWT). `error` is
 * GitHub's message when the installation list could not be read.
 */
export type GitHubAppInstallation = {
  id: number
  /** Organization or user the App is installed on. */
  account: string
  repositorySelection: 'all' | 'selected'
}
export type GitHubAppResponse = {
  webhookUrl: string
  installations: GitHubAppInstallation[]
  error: string | null
}

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

/**
 * GET /api/agents -> availability and model lists
 * POST /api/agents/refresh?agent=claude|codex -> AgentsResponse
 * Re-reads the model list from the CLI (both agents without `agent`), running it in a
 * helper sandbox with the stored credential; waits for the result. A failed refresh
 * keeps the previous list and reports the error in `modelsError`.
 */
export type ModelsSource = 'cli' | 'api' | 'default'
export type AgentInfo = {
  id: AgentKind
  label: string
  /** False when no credential is configured. */
  available: boolean
  reason: string | null
  models: ModelOption[]
  /** The settings default when the list contains it, else the CLI's own default, else the first entry. */
  defaultModel: string
  /** `cli`: reported by the CLI; `api`: the vendor's models API; `default`: the static fallback list. */
  modelsSource: ModelsSource
  modelsRefreshedAt: string | null
  /** Why the last refresh failed; null after a success or when none ran. */
  modelsError: string | null
}
export type AgentsResponse = { agents: AgentInfo[] }

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Core notifies on three thread transitions (see `NotificationEvent`) through Web
 * Push (one subscription per browser) and outbound webhooks.
 *
 * GET    /api/notifications -> NotificationSettings
 * POST   /api/notifications/subscriptions PushSubscriptionRequest -> 204
 * DELETE /api/notifications/subscriptions { endpoint } -> 204
 * POST   /api/notifications/test { endpoint } -> NotificationTestResponse (that browser only)
 * PUT    /api/notifications/webhooks -> NotificationSettings (replaces the list; a
 *        webhook whose `secret` is omitted keeps the stored one)
 * POST   /api/notifications/webhooks/:id/test -> NotificationTestResponse
 */
export type NotificationsResponse = NotificationSettings

/** `PushSubscription.toJSON()` from the browser, minus fields core does not store. */
export type PushSubscriptionRequest = { endpoint: string; keys: { p256dh: string; auth: string } }

/** Names one stored subscription: the one to forget, or the one to test. */
export type PushEndpointRequest = { endpoint: string }

export type PutWebhooksRequest = {
  webhooks: Array<{ id?: string; kind: WebhookKind; url: string; secret?: string; events: NotificationEvent[] }>
}

export type NotificationTestResponse = { ok: boolean; error: string | null }

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

/** GET /api/projects/:id -> Project ; PATCH /api/projects/:id ; DELETE -> 204 (fails 409 while threads exist unless ?force=1) */
export type UpdateProjectRequest = {
  name?: string
  defaultBranch?: string
  autoCreatePr?: boolean
  archiveOnMerge?: boolean
  autoFixCi?: boolean
  redactSecrets?: boolean
}

/**
 * GET /api/snapshots -> storage held by project snapshots.
 * DELETE /api/projects/:id/snapshot -> 204; the next thread on the project builds a new one.
 */
export type SnapshotsResponse = {
  enabled: boolean
  count: number
  totalBytes: number
  budgetBytes: number
}

/** GET /api/projects/:id/env -> { vars } ; PUT /api/projects/:id/env { vars: [{name, value, kind}] } replaces all ; values omitted keep existing */
export type ProjectEnvResponse = { vars: ProjectEnvVar[] }
export type PutProjectEnvRequest = {
  vars: Array<{ name: string; value?: string; kind: 'plain' | 'secret' }>
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/** GET /api/mcp-servers -> { servers } by name */
export type McpServersResponse = { servers: McpServer[] }

/** A header (http) or environment variable (stdio); an omitted `value` keeps the stored one. */
export type McpValueInput = { name: string; value?: string | undefined }

/**
 * POST /api/mcp-servers -> McpServer (201)
 * PUT  /api/mcp-servers/:id -> McpServer (replaces the whole server)
 * DELETE /api/mcp-servers/:id -> 204
 */
export type McpServerInput = {
  name: string
  enabled?: boolean | undefined
  scope?: McpServerScope | undefined
  /** Required when `scope === 'selected'`. */
  projectIds?: string[] | undefined
} & (
  | { type: 'http'; url: string; headers: McpValueInput[] }
  | { type: 'stdio'; command: string; args?: string[] | undefined; env: McpValueInput[] }
)

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export type ThreadListItem = Thread & {
  projectName: string
  diffStats: DiffStats | null
  /** Enabled MCP servers that apply to this thread's project. */
  mcpServers: number
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

/** GET /api/threads/:id -> ThreadListItem ; PATCH { title?, autoFixCi? } ; DELETE -> 204 (removes container and volume) */
export type UpdateThreadRequest = { title?: string; autoFixCi?: boolean }

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
// Sharing
// ---------------------------------------------------------------------------

/**
 * A thread is private until an unlisted link is created for it. The link carries
 * an AES-GCM token bound to the thread and to a generation counter; revoking bumps
 * the generation, which kills every link issued so far. Links do not expire.
 *
 * GET    /api/threads/:id/share -> ThreadShareResponse
 * POST   /api/threads/:id/share -> ThreadShareResponse with `url` set
 * DELETE /api/threads/:id/share -> 204
 */
export type ThreadShareResponse = { shared: boolean; url: string | null }

/** Where an unlisted link points: `<VALET_BASE_URL>/s/<token>`. */
export const SHARE_PATH = '/s'

/**
 * The thread as a link holder sees it: the transcript and the diff, without cost,
 * ids, or any way into the sandbox.
 *
 * GET /api/share/:token -> SharedThreadResponse
 * GET /api/share/:token/changes -> ChangesResponse
 * WS  /api/share/:token/stream?since=<seq> -> StreamFrame, minus `portals` and
 *     `services` frames and with every cost figure removed.
 *
 * These are the only routes under `/api` that need no session. A token that is
 * malformed, forged, or from a revoked generation answers 404, as does any token
 * once too many attempts have failed in the last minute.
 */
export type SharedThread = {
  title: string
  projectName: string
  agent: AgentKind
  model: string
  status: ThreadStatus
  error: string | null
  branch: string
  baseBranch: string
}
export type SharedThreadResponse = { thread: SharedThread }

// ---------------------------------------------------------------------------
// GitHub webhooks
// ---------------------------------------------------------------------------

/**
 * POST /api/webhooks/github
 *
 * The GitHub App's webhook endpoint. Authenticated by the `X-Hub-Signature-256`
 * HMAC over the raw body with the stored webhook secret, not by the session
 * cookie, so it is mounted ahead of the session check. Answers 202 once the
 * delivery is accepted, 401 for a bad signature, 503 when no App is configured.
 *
 * Handled: `check_run`, `check_suite`, and `workflow_run` completions with
 * conclusion `failure` (one message per head commit, up to `CI_FIX_MAX_ATTEMPTS`
 * per pull request); `issue_comment` and `pull_request_review_comment` creations
 * that mention `@valet` and come from a repository owner, member, or collaborator,
 * since the comment becomes a prompt; `pull_request` closures and reopenings
 * (updates `pr.state`, archives the thread on merge when the project says so).
 */
export const GITHUB_WEBHOOK_PATH = '/api/webhooks/github'

// ---------------------------------------------------------------------------
// Portals
// ---------------------------------------------------------------------------

/**
 * Every TCP port listening inside a running sandbox (except the supervisor and
 * VNC ports) is a portal at `${scheme}://t-<thread>-p<port>.<VALET_PORTAL_DOMAIN>`.
 * Core polls the supervisor's `/ports` while the container runs and pushes changes
 * as `{ t: 'portals' }` stream frames.
 *
 * GET /api/threads/:id/portals -> { portals } (the last known list while paused)
 */
export type PortalsResponse = { portals: Portal[] }

/**
 * POST /api/threads/:id/portals/:port/share { hours } -> { url, expiresAt }
 * `url` is `<portal origin>/__valet/auth?token=...`; opening it grants access to
 * that one portal for `hours` without a Valet login.
 * DELETE /api/threads/:id/portals/:port/share -> 204; every link issued so far for
 * the port stops working.
 */
/**
 * GET /api/threads/:id/portals/:port/auth?path=/some/path -> { url }
 * A portal URL that signs the browser in on that host and lands on `path`
 * (`<portal origin>/__valet/auth?token=...`, valid for 60 s). The Portals tab loads
 * its iframe from this, because inside a cross-site frame the session cookie never
 * reaches `/api/portal-auth`. Without `VALET_PASSWORD` it is the plain portal URL.
 */
export type PortalAuthUrlResponse = { url: string }

export const SHARE_HOURS = [1, 3, 24, 168] as const
export type ShareHours = (typeof SHARE_HOURS)[number]
export type SharePortalRequest = { hours: ShareHours }
export type SharePortalResponse = { url: string; expiresAt: string }

/**
 * Portal-host routes, served by core through the web app's Host rewrite:
 *
 *   ANY  <portal>/*                  proxied to the app inside the sandbox
 *   GET  <portal>/__valet/auth?token= sets the `valet_portal` cookie for this host, then redirects
 *   POST <portal>/__valet/wake       wakes a paused sandbox (owner only), then redirects to /
 *   GET  <portal>/__valet/review.js  the review widget (owner only)
 *   POST <portal>/__valet/review     PortalReviewRequest -> 204 (owner only)
 *   GET  /api/portal-auth?return=<portal URL>  (main host) turns a valid `valet_session`
 *        into a short-lived token and redirects to `<portal>/__valet/auth`
 *
 * With `VALET_PASSWORD` set, a portal request without a valid `valet_portal` cookie
 * is redirected to `/api/portal-auth`. Without it, portals are open like the UI.
 */
export const PORTAL_AUTH_PATH = '/__valet/auth'
export const PORTAL_WAKE_PATH = '/__valet/wake'
export const PORTAL_REVIEW_PATH = '/__valet/review'
export const PORTAL_REVIEW_SCRIPT_PATH = '/__valet/review.js'

/**
 * A comment made with the review widget core injects into an owner's portal pages.
 * Core sends it to the thread as a user message (steering the running turn, else
 * queued behind it).
 */
export type PortalReviewRequest = {
  /** CSS selector for the commented element, from the widget's DOM walk. */
  selector: string
  /** Path inside the portal the comment was made on. */
  path: string
  /** First 200 characters of the element's text. */
  excerpt: string
  note: string
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Managed services inside the sandbox (see `Service`). Core polls the supervisor's
 * `/services` alongside `/ports` while the container runs and pushes the list as
 * `{ t: 'services' }` stream frames; the last known list is kept while paused.
 *
 * GET    /api/threads/:id/services -> { services }
 * POST   /api/threads/:id/services CreateServiceRequest -> CreateServiceResponse (201)
 * POST   /api/threads/:id/services/:name/start|stop|restart -> CreateServiceResponse
 * DELETE /api/threads/:id/services/:name -> 204
 * GET    /api/threads/:id/services/:name/logs?lines=200 -> text/plain
 * WS     /api/threads/:id/services/:name/logs?lines=200 -> ServiceLogsFrame (relayed)
 *
 * Everything but GET /services answers 409 `{ error: 'paused' }` while the container
 * is not running.
 */
export type ServicesResponse = { services: Service[] }
export type { CreateServiceRequest }
export type CreateServiceResponse = { service: Service; readiness: ServiceReadiness }

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** `7d` and `30d` are calendar days in UTC, ending with today; `all` starts at the first turn. */
export type UsageRange = '7d' | '30d' | 'all'
export const USAGE_RANGES = ['7d', '30d', 'all'] as const satisfies readonly UsageRange[]

/**
 * Rolled up from `turn.end` events. `costUsd` is null when no turn in the group
 * reported one: Codex does not report cost, so a Codex-only group is "not tracked",
 * which is not the same as $0.00.
 */
export type UsageTotals = {
  costUsd: number | null
  inputTokens: number
  outputTokens: number
  turns: number
  threads: number
}

export type UsageByProject = UsageTotals & { projectId: string; projectName: string }
export type UsageByModel = UsageTotals & { agent: AgentKind; model: string }
/** Buckets of the `daily` series; `all` switches to `week` once it spans more than 90 days. */
export type UsageBucket = 'day' | 'week'
/** `day` is `YYYY-MM-DD` in UTC: the day, or the Monday of the week when the bucket is `week`. Buckets without turns are present with zeros. */
export type UsageDay = UsageTotals & { day: string }
/** The most recent rate-limit window an agent reported, across all of its threads; windows past their reset are dropped. */
export type UsageRateLimit = RateLimitInfo & { agent: AgentKind; observedAt: string }

/**
 * GET /api/usage?range=7d|30d|all
 *
 * A thread's turns are attributed to the thread's current project, agent, and model;
 * changing a thread's model moves its whole history to the new one.
 */
export type UsageResponse = {
  range: UsageRange
  /** Start of the range, null for `all`. */
  since: string | null
  totals: UsageTotals
  byProject: UsageByProject[]
  byModel: UsageByModel[]
  bucket: UsageBucket
  daily: UsageDay[]
  rateLimits: UsageRateLimit[]
}

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
  /** Full current list, sent once after replay and again whenever it changes. */
  | { t: 'portals'; portals: Portal[] }
  /** Full current list, sent once after replay and on every poll while the sandbox runs. */
  | { t: 'services'; services: Service[] }
  /** Memory and CPU of the running container, sampled every 10 s while anyone watches. */
  | { t: 'usage'; usage: SandboxUsage }
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
 * The user's own shell in the sandbox: a tmux session every viewer attaches to,
 * separate from the agent. Frames are JSON; terminal bytes are base64.
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
