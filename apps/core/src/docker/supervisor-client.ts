import { WebSocket, type RawData } from 'ws'
import {
  createServiceReplySchema,
  ensureReplySchema,
  execServerFrameSchema,
  fsListReplySchema,
  healthReplySchema,
  portsReplySchema,
  runReplySchema,
  servicesReplySchema,
  type AgentProcess,
  type CreateServiceReply,
  type CreateServiceRequest,
  type EnsureReply,
  type ExecClientFrame,
  type ExecServerFrame,
  type FsListReply,
  type HealthReply,
  type PortsReply,
  type ProcessRunner,
  type RunReply,
  type RunRequest,
  type Service,
  type SpawnOptions,
} from '@valet/shared'
import { HttpError } from '../errors.js'
import { newId } from '../ids.js'
import { logger, errorMessage } from '../logger.js'

const log = logger('supervisor')

const HEALTH_PROBE_MS = 1500
const HEALTH_POLL_MS = 500

export function rawToBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw)
  return Buffer.from(raw)
}

export class SupervisorClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra }
  }

  private async request(path: string, init: RequestInit & { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
    const { timeoutMs, signal, ...rest } = init
    const timeout = AbortSignal.timeout(timeoutMs ?? 30_000)
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...rest,
      headers: this.headers((rest.headers as Record<string, string> | undefined) ?? {}),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    })
    return res
  }

  private async expectOk(res: Response, what: string): Promise<Response> {
    if (res.ok) return res
    const text = await res.text().catch(() => '')
    throw new HttpError(res.status, `supervisor ${what}: ${res.status} ${text}`.trim())
  }

  async health(timeoutMs = HEALTH_PROBE_MS): Promise<HealthReply> {
    const res = await this.expectOk(await this.request('/health', { timeoutMs }), 'health')
    return healthReplySchema.parse(await res.json())
  }

  /** Aborting `signal` stops waiting; the process itself runs on until it exits or hits `timeoutMs`. */
  async run(req: RunRequest, signal?: AbortSignal): Promise<RunReply> {
    const res = await this.expectOk(
      await this.request('/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        timeoutMs: (req.timeoutMs ?? 120_000) + 15_000,
        ...(signal ? { signal } : {}),
      }),
      'run',
    )
    return runReplySchema.parse(await res.json())
  }

  async fsList(path: string): Promise<FsListReply | null> {
    const res = await this.request(`/fs/list?path=${encodeURIComponent(path)}`)
    if (res.status === 404) return null
    await this.expectOk(res, 'fs/list')
    return fsListReplySchema.parse(await res.json())
  }

  /** Null when the file does not exist. Throws HttpError(413) when larger than 5 MB. */
  async fsRead(path: string): Promise<Buffer | null> {
    const res = await this.request(`/fs/read?path=${encodeURIComponent(path)}`)
    if (res.status === 404) return null
    await this.expectOk(res, 'fs/read')
    return Buffer.from(await res.arrayBuffer())
  }

  async fsWrite(path: string, data: Buffer | string, mode?: string): Promise<void> {
    const q = new URLSearchParams({ path })
    if (mode) q.set('mode', mode)
    await this.expectOk(
      await this.request(`/fs/write?${q.toString()}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
      }),
      'fs/write',
    )
  }

  async fsMkdir(path: string): Promise<void> {
    await this.expectOk(
      await this.request('/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      }),
      'fs/mkdir',
    )
  }

  /** Listening ports, minus loopback-only ones owned by `excludePids` or their descendants (the agent's own bridges). */
  async ports(excludePids: number[] = []): Promise<PortsReply> {
    const q = excludePids.length > 0 ? `?excludePids=${excludePids.join(',')}` : ''
    const res = await this.expectOk(await this.request(`/ports${q}`, { timeoutMs: 5_000 }), 'ports')
    return portsReplySchema.parse(await res.json())
  }

  /** Where a portal request for `port` goes, with the bearer header the supervisor expects. */
  portalTarget(port: number, pathAndQuery: string): { url: URL; headers: Record<string, string> } {
    return { url: new URL(`/portal/${port}${pathAndQuery}`, this.baseUrl), headers: this.headers() }
  }

  // ---- services ----------------------------------------------------------------------

  async services(): Promise<Service[]> {
    const res = await this.expectOk(await this.request('/services', { timeoutMs: 5_000 }), 'services')
    return servicesReplySchema.parse(await res.json()).services
  }

  /** Creates or replaces; resolves after readiness, which can take up to a minute. */
  async createService(req: CreateServiceRequest): Promise<CreateServiceReply> {
    const res = await this.expectOk(
      await this.request('/services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), timeoutMs: 90_000 }),
      'services',
    )
    return createServiceReplySchema.parse(await res.json())
  }

  async serviceAction(name: string, action: 'start' | 'stop' | 'restart'): Promise<CreateServiceReply> {
    const res = await this.expectOk(
      await this.request(`/services/${encodeURIComponent(name)}/${action}`, { method: 'POST', timeoutMs: 90_000 }),
      `services/${action}`,
    )
    return createServiceReplySchema.parse(await res.json())
  }

  async removeService(name: string): Promise<void> {
    await this.expectOk(await this.request(`/services/${encodeURIComponent(name)}`, { method: 'DELETE' }), 'services/remove')
  }

  async serviceLogs(name: string, lines: number): Promise<string> {
    const res = await this.expectOk(await this.request(`/services/${encodeURIComponent(name)}/logs?lines=${lines}`), 'services/logs')
    return res.text()
  }

  async ensureServices(): Promise<EnsureReply> {
    const res = await this.expectOk(await this.request('/services/ensure', { method: 'POST', timeoutMs: 120_000 }), 'services/ensure')
    return ensureReplySchema.parse(await res.json())
  }

  /** `/services/<name>/logs?lines=N` for the browser relay. */
  serviceLogsPath(name: string, lines: number): string {
    return `/services/${encodeURIComponent(name)}/logs?lines=${lines}`
  }

  openSocket(path: string): WebSocket {
    const url = `${this.baseUrl.replace(/^http/, 'ws')}${path}`
    return new WebSocket(url, { headers: this.headers(), perMessageDeflate: false })
  }

  async openExec(): Promise<ExecSocket> {
    const ws = this.openSocket('/exec')
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', (err) => reject(err))
    })
    return new ExecSocket(ws)
  }
}

/**
 * Tries each candidate URL until one answers /health or the deadline passes.
 * A container that has just started may need a few seconds for the supervisor
 * to listen, so DNS failures and refused connections are both retried.
 */
export async function waitForSupervisor(candidates: string[], token: string, timeoutMs: number, signal?: AbortSignal): Promise<SupervisorClient> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no candidates'
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    for (const url of candidates) {
      const client = new SupervisorClient(url, token)
      try {
        await client.health()
        return client
      } catch (err) {
        lastError = `${url}: ${errorMessage(err)}`
      }
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
  }
  throw new Error(`sandbox supervisor did not become healthy within ${Math.round(timeoutMs / 1000)} s (${lastError})`)
}

// ---------------------------------------------------------------------------
// /exec: ProcessRunner over one multiplexed socket
// ---------------------------------------------------------------------------

type ExecSpawnOptions = SpawnOptions & { detach?: boolean; killGroupOnExit?: boolean }

class ExecProcess implements AgentProcess {
  pid: number | null = null
  private stdoutBuf: Buffer = Buffer.alloc(0)
  private readonly lineCbs: Array<(line: string) => void> = []
  private readonly stderrCbs: Array<(chunk: string) => void> = []
  private stdinOpen = true
  private done = false
  private resolveExit!: (v: { code: number | null; signal: string | null }) => void
  readonly exited: Promise<{ code: number | null; signal: string | null }>

  constructor(
    readonly id: string,
    private readonly send: (frame: ExecClientFrame) => void,
  ) {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve
    })
  }

  handle(frame: ExecServerFrame): void {
    switch (frame.t) {
      case 'started':
        this.pid = frame.pid
        return
      case 'stdout':
        this.pushStdout(Buffer.from(frame.data, 'base64'))
        return
      case 'stderr': {
        const text = Buffer.from(frame.data, 'base64').toString('utf8')
        for (const cb of this.stderrCbs) cb(text)
        return
      }
      case 'exit':
        this.finish(frame.code, frame.signal)
        return
      case 'error':
        // Post-start errors (bad signal name, etc.) are reported but not fatal.
        log.warn('exec error', { id: this.id, message: frame.message })
        return
    }
  }

  private pushStdout(chunk: Buffer): void {
    this.stdoutBuf = this.stdoutBuf.length === 0 ? chunk : Buffer.concat([this.stdoutBuf, chunk])
    let start = 0
    for (;;) {
      const nl = this.stdoutBuf.indexOf(0x0a, start)
      if (nl === -1) break
      const line = this.stdoutBuf.subarray(start, nl).toString('utf8')
      start = nl + 1
      this.emitLine(line)
    }
    if (start > 0) this.stdoutBuf = this.stdoutBuf.subarray(start)
  }

  private emitLine(line: string): void {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line
    for (const cb of this.lineCbs) cb(clean)
  }

  finish(code: number | null, signal: string | null): void {
    if (this.done) return
    this.done = true
    this.stdinOpen = false
    if (this.stdoutBuf.length > 0) {
      this.emitLine(this.stdoutBuf.toString('utf8'))
      this.stdoutBuf = Buffer.alloc(0)
    }
    this.resolveExit({ code, signal })
  }

  async write(data: string): Promise<void> {
    if (!this.stdinOpen) throw new Error('stdin is closed')
    this.send({ t: 'stdin', id: this.id, data: Buffer.from(data, 'utf8').toString('base64') })
  }

  async closeStdin(): Promise<void> {
    if (!this.stdinOpen) return
    this.stdinOpen = false
    this.send({ t: 'stdin-close', id: this.id })
  }

  async signal(sig: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void> {
    if (this.done) return
    this.send({ t: 'signal', id: this.id, signal: sig })
  }

  onStdoutLine(cb: (line: string) => void): void {
    this.lineCbs.push(cb)
  }

  onStderr(cb: (chunk: string) => void): void {
    this.stderrCbs.push(cb)
  }
}

export class ExecSocket implements ProcessRunner {
  private readonly procs = new Map<string, ExecProcess>()
  private readonly starting = new Map<string, { resolve: (p: ExecProcess) => void; reject: (e: Error) => void }>()
  private readonly closeCbs: Array<() => void> = []
  closed = false

  constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => this.onMessage(raw))
    ws.on('close', () => this.handleClose())
    ws.on('error', (err) => {
      log.warn('exec socket error', { err })
    })
  }

  private send(frame: ExecClientFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('exec socket is closed')
    this.ws.send(JSON.stringify(frame))
  }

  private onMessage(raw: RawData): void {
    let parsed: ReturnType<typeof execServerFrameSchema.safeParse>
    try {
      parsed = execServerFrameSchema.safeParse(JSON.parse(rawToBuffer(raw).toString('utf8')))
    } catch {
      log.warn('exec: invalid JSON frame')
      return
    }
    if (!parsed.success) {
      log.warn('exec: unknown frame', { issues: parsed.error.issues })
      return
    }
    const frame = parsed.data
    const pending = this.starting.get(frame.id)
    if (pending) {
      if (frame.t === 'started') {
        this.starting.delete(frame.id)
        const proc = this.procs.get(frame.id)
        if (proc) {
          proc.handle(frame)
          pending.resolve(proc)
        }
        return
      }
      if (frame.t === 'error') {
        this.starting.delete(frame.id)
        this.procs.delete(frame.id)
        pending.reject(new Error(frame.message))
        return
      }
    }
    const proc = this.procs.get(frame.id)
    if (!proc) return
    proc.handle(frame)
    if (frame.t === 'exit') this.procs.delete(frame.id)
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    for (const [id, pending] of this.starting) {
      pending.reject(new Error('exec socket closed before the process started'))
      this.starting.delete(id)
    }
    for (const proc of this.procs.values()) proc.finish(null, 'SOCKET_CLOSED')
    this.procs.clear()
    for (const cb of this.closeCbs) cb()
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb)
  }

  spawn(options: ExecSpawnOptions): Promise<AgentProcess> {
    const id = newId()
    const proc = new ExecProcess(id, (f) => this.send(f))
    this.procs.set(id, proc)
    return new Promise<ExecProcess>((resolve, reject) => {
      this.starting.set(id, { resolve, reject })
      try {
        this.send({
          t: 'start',
          id,
          argv: options.argv,
          cwd: options.cwd,
          env: options.env,
          ...(options.detach ? { detach: true } : {}),
          ...(options.killGroupOnExit ? { killGroupOnExit: true } : {}),
        })
      } catch (err) {
        this.starting.delete(id)
        this.procs.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close()
  }
}

// ---------------------------------------------------------------------------
// Browser <-> supervisor relays (/pty JSON text frames, /vnc binary frames)
// ---------------------------------------------------------------------------

/**
 * Frames the browser sends before the upstream socket exists must not be lost:
 * call `holdBrowserFrames` as soon as the upgrade completes and pass the result on.
 */
export type HeldFrames = { frames: Array<{ data: Buffer; binary: boolean }>; release(): void }

export function holdBrowserFrames(browser: WebSocket): HeldFrames {
  const frames: Array<{ data: Buffer; binary: boolean }> = []
  const onMessage = (raw: RawData, isBinary: boolean): void => {
    frames.push({ data: rawToBuffer(raw), binary: isBinary })
  }
  browser.on('message', onMessage)
  return {
    frames,
    release: () => {
      browser.off('message', onMessage)
    },
  }
}

/** Closes a socket that nobody listens to any more, including one still connecting. */
export function discardSocket(ws: WebSocket): void {
  // Closing while CONNECTING aborts the handshake and emits 'error' first.
  ws.on('error', () => undefined)
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000, 'browser gone')
}

export function relay(browser: WebSocket, upstream: WebSocket, held?: HeldFrames): void {
  if (browser.readyState !== WebSocket.OPEN) {
    // The browser's 'close' already fired; a listener attached now would never run.
    held?.release()
    discardSocket(upstream)
    return
  }
  const closeBoth = (code: number, reason: string): void => {
    const safeCode = code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000
    if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) browser.close(safeCode, reason)
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(safeCode, reason)
  }
  const pendingFromBrowser: Array<{ data: Buffer; binary: boolean }> = held?.frames.splice(0) ?? []
  held?.release()

  const toUpstream = (data: Buffer, binary: boolean): void => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
    else if (upstream.readyState === WebSocket.CONNECTING) pendingFromBrowser.push({ data, binary })
  }
  browser.on('message', (raw, isBinary) => toUpstream(rawToBuffer(raw), isBinary))
  upstream.on('open', () => {
    for (const m of pendingFromBrowser.splice(0)) upstream.send(m.data, { binary: m.binary })
  })
  if (upstream.readyState === WebSocket.OPEN) {
    for (const m of pendingFromBrowser.splice(0)) upstream.send(m.data, { binary: m.binary })
  }
  upstream.on('message', (raw, isBinary) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(rawToBuffer(raw), { binary: isBinary })
  })
  browser.on('close', (code, reason) => closeBoth(code, reason.toString()))
  upstream.on('close', (code, reason) => closeBoth(code, reason.toString()))
  browser.on('error', () => closeBoth(1011, 'browser socket error'))
  upstream.on('error', (err) => {
    log.warn('relay upstream error', { message: errorMessage(err) })
    closeBoth(1011, 'sandbox socket error')
  })
}
