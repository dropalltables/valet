/**
 * Protocol between core and the supervisor that runs inside every sandbox
 * container (`sandbox/supervisor`).
 *
 * Transport: HTTP + WebSocket on `SANDBOX.supervisorPort` (9500), reachable only on
 * the compose network. Every request carries `Authorization: Bearer <token>` where
 * the token is the container's `VALET_SUPERVISOR_TOKEN` env var, minted by core per
 * container. Binary payloads travel as base64 inside JSON; the `/vnc` socket is the
 * one exception (raw binary frames).
 *
 * Endpoints
 *   GET  /health                -> HealthReply
 *   POST /run                   RunRequest -> RunReply   (run to completion, small output)
 *   WS   /exec                  ExecClientFrame / ExecServerFrame (long-lived processes)
 *   WS   /pty                   PtyClientFrame / PtyServerFrame (tmux-attached shell)
 *   WS   /vnc                   raw RFB bytes <-> 127.0.0.1:5901
 *   GET  /fs/list?path=         -> FsListReply
 *   GET  /fs/read?path=         -> raw bytes (200) ; 404 ; 413 when > 5 MB
 *   PUT  /fs/write?path=&mode=  raw bytes -> 204 (creates parent dirs)
 *   POST /fs/mkdir { path }     -> 204
 *   GET  /ports?excludePids=    -> PortsReply (TCP ports in LISTEN state, minus 9500 and 5901,
 *                               minus listeners owned by the given pids or their descendants,
 *                               minus loopback-only listeners of `claude`/`codex` processes;
 *                               each port names the registered service that owns it, if any)
 *   ANY  /portal/:port/*        proxied to 127.0.0.1:<port> with Host `localhost:<port>`;
 *                               WebSocket upgrades are tunnelled byte for byte. The
 *                               supervisor's own failures carry `PORTAL_ERROR_HEADER`
 *                               so core can tell them from the app's responses.
 *
 * Services (supervisord programs the supervisor writes and drives; see `Service`):
 *   GET    /services                    -> ServicesReply
 *   POST   /services                    CreateServiceRequest -> CreateServiceReply (creates or
 *                                       replaces, starts, waits for readiness)
 *   POST   /services/ensure             -> EnsureReply (reconcile `.valet/services.yaml`)
 *   POST   /services/:name/start|stop|restart -> CreateServiceReply (readiness is `skipped` for stop)
 *   DELETE /services/:name              -> 204 (stops, removes unit, registry entry, logs)
 *   GET    /services/:name/logs?lines=  -> text/plain, the last `lines` (default 200)
 *   WS     /services/:name/logs?lines=  ServiceLogsFrame: `tail -F` of the log file
 *
 * The same API, minus everything but /health, /ports, and /services*, is served
 * without a token on the UNIX socket `SANDBOX.controlSocket` for the `valet` CLI
 * inside the container. /exec, /pty, /vnc, /portal, /fs, and /run answer 403 there.
 */

import { z } from 'zod'
import { SERVICE_NAME_RE, type Service, type ServiceReadiness } from './domain.js'

export const SUPERVISOR_TOKEN_ENV = 'VALET_SUPERVISOR_TOKEN'

export const healthReplySchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  uptimeSeconds: z.number(),
  /** Whether the VNC server is accepting connections. */
  desktop: z.boolean(),
  /** Number of processes currently running via /exec and /run. */
  processes: z.number(),
})
export type HealthReply = z.infer<typeof healthReplySchema>

export const runRequestSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Bytes to write to stdin before closing it (utf8). */
  stdin: z.string().optional(),
  /** Kill after this many ms; default 120000. */
  timeoutMs: z.number().optional(),
})
export type RunRequest = z.infer<typeof runRequestSchema>

export const runReplySchema = z.object({
  code: z.number().nullable(),
  signal: z.string().nullable(),
  /** utf8, truncated to 2 MB each with a trailing marker. */
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
})
export type RunReply = z.infer<typeof runReplySchema>

/**
 * /exec: many processes per socket, multiplexed by `id`.
 *
 * Processes are killed (SIGTERM, then SIGKILL after 5 s) when the socket closes
 * unless they were started with `detach: true`. Core keeps one `/exec` socket open
 * per live container for the agent process; a reconnect after a core restart cannot
 * reattach to a detached process's stdio, so core relaunches the agent instead
 * (Claude `--resume`, Codex `thread/resume`).
 */
export const execClientFrameSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('start'),
    id: z.string(),
    argv: z.array(z.string()).min(1),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    /** Allocate a pty instead of pipes (for programs that need a tty). */
    pty: z.object({ cols: z.number(), rows: z.number() }).optional(),
    detach: z.boolean().optional(),
    /**
     * When the process exits, SIGTERM (then SIGKILL) whatever it left behind in its
     * process group: for setup scripts, so a stray `&` does not outlive them.
     */
    killGroupOnExit: z.boolean().optional(),
  }),
  /** base64 */
  z.object({ t: z.literal('stdin'), id: z.string(), data: z.string() }),
  z.object({ t: z.literal('stdin-close'), id: z.string() }),
  z.object({ t: z.literal('signal'), id: z.string(), signal: z.string() }),
  z.object({ t: z.literal('resize'), id: z.string(), cols: z.number(), rows: z.number() }),
])
export type ExecClientFrame = z.infer<typeof execClientFrameSchema>

export const execServerFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('started'), id: z.string(), pid: z.number() }),
  /** base64 */
  z.object({ t: z.literal('stdout'), id: z.string(), data: z.string() }),
  /** base64 */
  z.object({ t: z.literal('stderr'), id: z.string(), data: z.string() }),
  z.object({ t: z.literal('exit'), id: z.string(), code: z.number().nullable(), signal: z.string().nullable() }),
  z.object({ t: z.literal('error'), id: z.string(), message: z.string() }),
])
export type ExecServerFrame = z.infer<typeof execServerFrameSchema>

/** /pty: one tmux client per socket, all attached to the session `SANDBOX.terminalSession`. */
export const ptyClientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('data'), data: z.string() }),
  z.object({ t: z.literal('resize'), cols: z.number(), rows: z.number() }),
])
export type SupervisorPtyClientFrame = z.infer<typeof ptyClientFrameSchema>

export const ptyServerFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('data'), data: z.string() }),
  z.object({ t: z.literal('exit'), code: z.number() }),
])
export type SupervisorPtyServerFrame = z.infer<typeof ptyServerFrameSchema>

export const fsEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(['file', 'dir', 'symlink', 'other']),
  size: z.number().nullable(),
  mtime: z.string().nullable(),
})
export const fsListReplySchema = z.object({
  path: z.string(),
  entries: z.array(fsEntrySchema),
})
export type FsListReply = z.infer<typeof fsListReplySchema>

export const fsMkdirRequestSchema = z.object({ path: z.string() })

export const portsReplySchema = z.object({
  ports: z.array(
    z.object({
      port: z.number(),
      /** Null when no readable process owns the socket. */
      pid: z.number().nullable(),
      /** argv[0] basename, else comm. */
      process: z.string().nullable(),
      /** Registered service assigned this port, if any. */
      service: z.string().nullable(),
    }),
  ),
})
export type PortsReply = z.infer<typeof portsReplySchema>

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export const serviceNameSchema = z.string().regex(SERVICE_NAME_RE, 'service names are 1-32 lowercase letters, digits, or hyphens, starting with a letter or digit')

export const servicePortalSchema = z.union([z.literal(false), z.object({ path: z.string(), title: z.string() })])

export const serviceSchema = z.object({
  name: z.string(),
  command: z.string(),
  cwd: z.string(),
  port: z.number().nullable(),
  url: z.string().nullable(),
  portal: servicePortalSchema,
  health: z.string().nullable(),
  /** Defaulted so a sandbox running a supervisor from before the review widget still parses. */
  review: z.boolean().default(true),
  source: z.enum(['adhoc', 'yaml']),
  state: z.enum(['running', 'starting', 'stopped', 'failed', 'exited']),
  pid: z.number().nullable(),
  uptimeSeconds: z.number().nullable(),
  restarts: z.number(),
  lastExitCode: z.number().nullable(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Service>

export const servicesReplySchema = z.object({ services: z.array(serviceSchema) })
export type ServicesReply = z.infer<typeof servicesReplySchema>

export const serviceReadinessSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['listening', 'responding', 'not-responding', 'exited', 'skipped']),
  httpStatus: z.number().nullable(),
  error: z.string().nullable(),
}) satisfies z.ZodType<ServiceReadiness>

/** Names the service may not set itself; the supervisor owns them. */
export const RESERVED_SERVICE_ENV = ['PORT', 'PUBLIC_URL', 'VALET_THREAD_ID', 'VALET_SERVICE', SUPERVISOR_TOKEN_ENV] as const

export const createServiceRequestSchema = z.object({
  name: serviceNameSchema,
  command: z.string().min(1),
  /** Absolute, or relative to the repo checkout. Defaults to the repo. */
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Explicit port; otherwise one is assigned when `portal` or `health` is set. */
  port: z.number().int().min(1).max(65535).optional(),
  /** `true` is `{ path: '/', title: <name> }`. */
  portal: z.union([z.boolean(), z.object({ path: z.string().optional(), title: z.string().optional() })]).optional(),
  health: z.string().startsWith('/').optional(),
})
export type CreateServiceRequest = z.infer<typeof createServiceRequestSchema>

export const createServiceReplySchema = z.object({ service: serviceSchema, readiness: serviceReadinessSchema })
export type CreateServiceReply = z.infer<typeof createServiceReplySchema>

/** `valet services ensure --json` */
export const ensureReplySchema = z.object({
  ok: z.boolean(),
  services: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      port: z.number().nullable(),
      url: z.string().nullable(),
      status: z.enum(['listening', 'responding', 'not-responding', 'exited', 'skipped']),
      healthStatus: z.number().optional(),
      healthError: z.string().optional(),
    }),
  ),
  /** Set when the file could not be read or resolved; `services` is then empty. */
  error: z.string().optional(),
})
export type EnsureReply = z.infer<typeof ensureReplySchema>

/** WS /services/:name/logs: base64 chunks of the log file as `tail -F` produces them. */
export const serviceLogsFrameSchema = z.object({ t: z.literal('data'), data: z.string() })
export type ServiceLogsFrame = z.infer<typeof serviceLogsFrameSchema>

/** Set on 502s the supervisor generates itself (app not listening, connect timeout). */
export const PORTAL_ERROR_HEADER = 'x-valet-portal-error'
/**
 * Core needs `Authorization` for the supervisor's bearer token, so the browser's own
 * `Authorization` (if any) travels in this header and is restored before the app sees it.
 */
export const PORTAL_APP_AUTHORIZATION_HEADER = 'x-valet-app-authorization'
/** `off` on an app's response keeps the review widget out of that page; core strips it. */
export const PORTAL_REVIEW_HEADER = 'x-valet-review'
/** Portal request env seen by processes in the sandbox. */
export const PORTAL_ENV = {
  threadId: 'VALET_THREAD_ID',
  /** `http://t-<thread>-p{port}.localhost:3000`; replace `{port}`. */
  urlTemplate: 'VALET_PORTAL_URL_TEMPLATE',
} as const
