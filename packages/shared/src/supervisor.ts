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
 *   GET  /ports                 -> PortsReply (TCP ports in LISTEN state, minus 9500 and 5901)
 *   ANY  /portal/:port/*        proxied to 127.0.0.1:<port> with Host `localhost:<port>`;
 *                               WebSocket upgrades are tunnelled byte for byte. The
 *                               supervisor's own failures carry `PORTAL_ERROR_HEADER`
 *                               so core can tell them from the app's responses.
 */

import { z } from 'zod'

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

/** /pty: one shell per socket, attached to the shared tmux session `main`. */
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
    }),
  ),
})
export type PortsReply = z.infer<typeof portsReplySchema>

/** Set on 502s the supervisor generates itself (app not listening, connect timeout). */
export const PORTAL_ERROR_HEADER = 'x-valet-portal-error'
/**
 * Core needs `Authorization` for the supervisor's bearer token, so the browser's own
 * `Authorization` (if any) travels in this header and is restored before the app sees it.
 */
export const PORTAL_APP_AUTHORIZATION_HEADER = 'x-valet-app-authorization'
/** Portal request env seen by processes in the sandbox. */
export const PORTAL_ENV = {
  threadId: 'VALET_THREAD_ID',
  /** `http://t-<thread>-p{port}.localhost:3000`; replace `{port}`. */
  urlTemplate: 'VALET_PORTAL_URL_TEMPLATE',
} as const
