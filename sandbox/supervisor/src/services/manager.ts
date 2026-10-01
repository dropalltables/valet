import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  SERVICE_ENV,
  RESERVED_SERVICE_ENV,
  SANDBOX,
  type CreateManagedServiceReply,
  type CreateManagedServiceRequest,
  type EnsureReply,
  type ManagedService,
  type ManagedServiceReadiness,
  type ManagedServiceState,
} from '@valet/shared'
import { HttpError } from '../http.js'
import { sleep } from '../process.js'
import { allocatePort } from './allocate.js'
import { waitReady, type Liveness } from './readiness.js'
import { Registry, type RegistryEntry } from './registry.js'
import {
  STATE,
  SupervisordFault,
  UNITS_DIR,
  allProcessInfo,
  envFile,
  logFile,
  processInfo,
  startUnit,
  stopUnit,
  unitConf,
  unitFile,
  unitName,
  updateUnits,
  type ProcessInfo,
} from './supervisord.js'
import { normalizeBrowser, parseServicesYaml, resolveEnv, wantsPort, type Declared } from './yaml.js'

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** How often process starts are sampled for the restart count between requests. */
const TRACK_MS = 2_000
/** After the port answers, how long to give supervisord to move STARTING -> RUNNING (startsecs=1). */
const STARTSECS_POLL_MS = 250
const STARTSECS_WAIT_POLLS = 12
const run = promisify(execFile)

/** Written by `valet-run-service`: the command's exit status, which supervisord forgets for early exits. */
const exitFile = (service: string): string => `${SANDBOX.serviceLogsDir}/${service}.exit`

const now = (): string => new Date().toISOString()

type Spec = Pick<RegistryEntry, 'command' | 'cwd' | 'port' | 'env' | 'browser' | 'health' | 'review'>

function specHash(spec: Spec): string {
  const env = Object.fromEntries(Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b)))
  return createHash('sha256')
    .update(JSON.stringify({ command: spec.command, cwd: spec.cwd, port: spec.port, env, browser: spec.browser, health: spec.health, review: spec.review }))
    .digest('hex')
}

function mapState(info: ProcessInfo | null): ManagedServiceState {
  if (!info) return 'stopped'
  switch (info.state) {
    case STATE.RUNNING:
      return 'running'
    case STATE.STARTING:
    case STATE.BACKOFF:
      return 'starting'
    case STATE.EXITED:
      return 'exited'
    case STATE.FATAL:
    case STATE.UNKNOWN:
      return 'failed'
    default:
      return 'stopped'
  }
}

/** Thrown for declared-services problems the caller reports as the ensure error rather than an HTTP failure. */
class EnsureError extends Error {}

export class ServiceManager {
  private readonly registry = new Registry()
  private readonly threadId = process.env[SERVICE_ENV.threadId] ?? null
  private readonly urlTemplate = process.env[SERVICE_ENV.urlTemplate] ?? null
  /** Last spawn time per unit and spawns seen beyond the first, since this supervisor started. */
  private readonly spawns = new Map<string, { start: number; restarts: number }>()
  /** Mutations (unit files + `supervisorctl update`) run one at a time, after boot. */
  private chain: Promise<void>

  constructor() {
    this.chain = this.boot().catch((err: unknown) => console.error(`services: boot failed: ${(err as Error).message}`))
    setInterval(() => void this.infoByUnit().catch(() => undefined), TRACK_MS).unref()
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Registry -> unit files -> supervisord, so registered services are back after every container start. */
  private async boot(): Promise<void> {
    await this.registry.load()
    await mkdir(SANDBOX.serviceLogsDir, { recursive: true })
    await mkdir(SANDBOX.serviceSpecsDir, { recursive: true, mode: 0o700 })
    await mkdir(UNITS_DIR, { recursive: true })
    const out = await this.regenerateUnits()
    console.log(`services: ${this.registry.all().length} registered${out ? `; ${out.replace(/\n/g, '; ')}` : ''}`)
  }

  /** Unit files back to exactly what the registry says, then `supervisorctl update`. */
  private async regenerateUnits(): Promise<string> {
    for (const f of await readdir(UNITS_DIR)) if (f.endsWith('.conf')) await rm(join(UNITS_DIR, f), { force: true })
    for (const e of this.registry.all()) await this.writeUnit(e)
    return updateUnits()
  }

  /**
   * Declared services are reconciled once per boot as well, so a wake needs no
   * resume script. Nothing here may reject: the supervisor must keep serving
   * /health, /exec, and /pty whatever the state of supervisord or the file.
   */
  bootEnsure(): void {
    this.locked(async () => existsSync(SANDBOX.servicesYaml))
      .then(async (declared) => {
        if (!declared) return
        const reply = await this.ensure()
        for (const s of reply.services) console.log(`services: ${s.name} ${s.status}${s.healthError ? ` (${s.healthError})` : ''}`)
        if (reply.error) console.error(`services: ensure: ${reply.error}`)
      })
      .catch((err: unknown) => console.error(`services: boot ensure failed: ${err instanceof Error ? err.message : String(err)}`))
  }

  urlFor(port: number | null): string | null {
    if (port === null || this.urlTemplate === null) return null
    return this.urlTemplate.replace('{port}', String(port))
  }

  portOwners(): Map<number, string> {
    return this.registry.portOwners()
  }

  // ---- state ------------------------------------------------------------------------

  private async infoByUnit(): Promise<Map<string, ProcessInfo>> {
    const infos = new Map<string, ProcessInfo>()
    for (const info of await allProcessInfo()) {
      infos.set(info.name, info)
      if (!info.name.startsWith('svc-') || info.start === 0) continue
      const seen = this.spawns.get(info.name)
      if (!seen) this.spawns.set(info.name, { start: info.start, restarts: 0 })
      else if (seen.start !== info.start) {
        seen.start = info.start
        seen.restarts += 1
      }
    }
    return infos
  }

  private async lastExitCode(name: string, info: ProcessInfo | null): Promise<number | null> {
    if (!info) return null
    const exited = info.state === STATE.EXITED || info.state === STATE.FATAL || info.state === STATE.BACKOFF
    if (!exited) return null
    const text = await readFile(exitFile(name), 'utf8').catch(() => '')
    const code = Number(text.trim())
    return text.trim() !== '' && Number.isInteger(code) ? code : null
  }

  private async toService(e: RegistryEntry, info: ProcessInfo | null): Promise<ManagedService> {
    const alive = info !== null && (info.state === STATE.RUNNING || info.state === STATE.STARTING)
    return {
      name: e.name,
      command: e.command,
      cwd: e.cwd,
      port: e.port,
      url: this.urlFor(e.port),
      browser: e.browser,
      health: e.health,
      review: e.review,
      source: e.source,
      state: mapState(info),
      pid: alive && info.pid > 0 ? info.pid : null,
      uptimeSeconds: alive ? Math.max(0, info.now - info.start) : null,
      restarts: this.spawns.get(unitName(e.name))?.restarts ?? 0,
      lastExitCode: await this.lastExitCode(e.name, info),
      updatedAt: e.updatedAt,
    }
  }

  async list(): Promise<ManagedService[]> {
    const infos = await this.infoByUnit()
    const entries = this.registry.all().sort((a, b) => a.name.localeCompare(b.name))
    return Promise.all(entries.map((e) => this.toService(e, infos.get(unitName(e.name)) ?? null)))
  }

  private entry(name: string): RegistryEntry {
    const e = this.registry.get(name)
    if (!e) throw new HttpError(404, `no service named ${name}`)
    return e
  }

  async get(name: string): Promise<ManagedService> {
    const e = this.entry(name)
    return this.toService(e, await processInfo(unitName(name)))
  }

  private liveness(name: string): () => Promise<Liveness> {
    return async () => {
      const info = await processInfo(unitName(name))
      if (!info) return { kind: 'exited', code: null }
      // BACKOFF is the first exit already observed: waiting out ten retries would only delay the same verdict.
      if (info.state === STATE.FATAL || info.state === STATE.EXITED || info.state === STATE.STOPPED || info.state === STATE.BACKOFF) {
        return { kind: 'exited', code: await this.lastExitCode(name, info) }
      }
      return { kind: 'alive' }
    }
  }

  /**
   * Port readiness (when there is a port), then supervisord's own verdict: a unit is
   * RUNNING once it has stayed up for `startsecs`, so a `status` right after `start`
   * agrees with it, and a command that exits at once is reported with its code
   * instead of as started.
   */
  private async readiness(e: RegistryEntry, startError: string | null = null): Promise<ManagedServiceReadiness> {
    if (startError !== null) return { ok: false, status: 'exited', httpStatus: null, error: startError }
    const ready = e.port === null ? { ok: true, status: 'skipped' as const, httpStatus: null, error: null } : await waitReady({ port: e.port, health: e.health, liveness: this.liveness(e.name) })
    for (let i = 0; ready.ok && i < STARTSECS_WAIT_POLLS; i++) {
      const info = await processInfo(unitName(e.name))
      if (!info) break
      if (info.state === STATE.BACKOFF || info.state === STATE.FATAL || info.state === STATE.EXITED) {
        const code = await this.lastExitCode(e.name, info)
        return { ok: false, status: 'exited', httpStatus: null, error: code === null ? 'process exited' : `exited with code ${code}` }
      }
      if (info.state !== STATE.STARTING) break
      await sleep(STARTSECS_POLL_MS)
    }
    return ready
  }

  /** Asks supervisord to start the unit; a spawn fault becomes the readiness error rather than an HTTP failure. */
  private async tryStart(name: string): Promise<string | null> {
    try {
      await startUnit(unitName(name))
      return null
    } catch (err) {
      if (err instanceof SupervisordFault) return err.message
      throw err
    }
  }

  // ---- validation ----------------------------------------------------------------------

  private validateEnv(env: Record<string, string>, where: string): void {
    for (const key of Object.keys(env)) {
      if (!ENV_NAME_RE.test(key)) throw new HttpError(400, `${where}: invalid variable name ${key}`)
      if ((RESERVED_SERVICE_ENV as readonly string[]).includes(key)) throw new HttpError(400, `${where}: ${key} is set by Valet`)
    }
  }

  private validateCommand(command: string): void {
    if (command.trim() === '') throw new HttpError(400, 'command is empty')
    if (command.includes('\0')) throw new HttpError(400, 'command may not contain NUL')
  }

  private async resolveCwd(cwd: string | undefined): Promise<string> {
    if (cwd === undefined) return existsSync(SANDBOX.repo) ? SANDBOX.repo : SANDBOX.home
    const abs = isAbsolute(cwd) ? cwd : resolve(SANDBOX.repo, cwd)
    const info = await stat(abs).catch(() => null)
    if (!info?.isDirectory()) throw new HttpError(400, `cwd is not a directory: ${abs}`)
    return abs
  }

  /** Explicit port wins; else the port this name had before; else the lowest free one in range. */
  private async assignPort(name: string, explicit: number | null, wants: boolean, taken: Set<number>): Promise<number | null> {
    if (explicit !== null) {
      const owner = this.registry.portOwners().get(explicit)
      if (owner !== undefined && owner !== name) throw new HttpError(409, `port ${explicit} belongs to service ${owner}`)
      if (owner === undefined && taken.has(explicit)) throw new HttpError(409, `port ${explicit} is already assigned to another declared service`)
      return explicit
    }
    if (!wants) return null
    return this.registry.get(name)?.port ?? allocatePort(taken)
  }

  // ---- units ---------------------------------------------------------------------------

  /** The unit plus the files its launcher reads: the command, the working directory, and the service's own env. */
  private async writeUnit(e: RegistryEntry): Promise<void> {
    await writeFile(join(SANDBOX.serviceSpecsDir, `${e.name}.cmd`), `${e.command}\n`, { mode: 0o600 })
    await writeFile(join(SANDBOX.serviceSpecsDir, `${e.name}.cwd`), `${e.cwd}\n`, { mode: 0o600 })
    await writeFile(join(SANDBOX.serviceSpecsDir, `${e.name}.env`), envFile(e.env), { mode: 0o600 })
    await writeFile(unitFile(e.name), unitConf(e, { threadId: this.threadId, url: this.urlFor(e.port) }))
  }

  /**
   * Writes and removes unit files, then `supervisorctl update`. The registry is
   * written by the caller only after this succeeded: a failed update must not leave
   * an entry that regenerates the same failing unit on every boot. On failure the
   * unit files are put back to what the registry says.
   */
  private async applyUnits(written: RegistryEntry[], removed: string[]): Promise<void> {
    for (const name of removed) await rm(unitFile(name), { force: true })
    for (const e of written) await this.writeUnit(e)
    try {
      await updateUnits()
    } catch (err) {
      for (const e of written) if (!this.registry.get(e.name)) await this.removeFiles(e.name).catch(() => undefined)
      await this.regenerateUnits().catch((e: unknown) => console.error(`services: restoring units failed: ${(e as Error).message}`))
      throw err
    }
  }

  private async removeFiles(name: string): Promise<void> {
    for (const ext of ['cmd', 'cwd', 'env']) await rm(join(SANDBOX.serviceSpecsDir, `${name}.${ext}`), { force: true })
    for (const f of await readdir(SANDBOX.serviceLogsDir).catch(() => [] as string[])) {
      if (f === `${name}.log` || f.startsWith(`${name}.log.`) || f === `${name}.exit`) await rm(join(SANDBOX.serviceLogsDir, f), { force: true })
    }
  }

  // ---- operations ------------------------------------------------------------------------

  /** Registers (or replaces) and starts; waits for readiness outside the mutation lock. */
  async create(req: CreateManagedServiceRequest): Promise<CreateManagedServiceReply> {
    this.validateCommand(req.command)
    const env = req.env ?? {}
    this.validateEnv(env, 'env')
    const cwd = await this.resolveCwd(req.cwd)
    const browser = normalizeBrowser(req.name, req.browser)
    const health = req.health ?? null
    const entry = await this.locked(async () => {
      const prev = this.registry.get(req.name)
      const port = await this.assignPort(req.name, req.port ?? null, browser !== false || health !== null, new Set(this.registry.portOwners().keys()))
      const stamp = now()
      const e: RegistryEntry = {
        name: req.name,
        command: req.command,
        cwd,
        env,
        port,
        browser,
        health,
        review: true,
        source: 'adhoc',
        specHash: null,
        createdAt: prev?.createdAt ?? stamp,
        updatedAt: stamp,
      }
      await this.applyUnits([e], [])
      await this.registry.put(e)
      // The unit text only names the launcher, so `update` leaves a replaced service running on its old spec.
      if (prev) await stopUnit(unitName(e.name))
      return { entry: e, startError: await this.tryStart(e.name) }
    })
    return this.reply(entry.entry, entry.startError)
  }

  /** Readiness first, so the returned snapshot is the state after the wait, not before it. */
  private async reply(e: RegistryEntry, startError: string | null): Promise<CreateManagedServiceReply> {
    const readiness = await this.readiness(e, startError)
    return { service: await this.get(e.name), readiness }
  }

  async start(name: string): Promise<CreateManagedServiceReply> {
    const e = this.entry(name)
    const startError = await this.locked(() => this.tryStart(name))
    return this.reply(e, startError)
  }

  async stop(name: string): Promise<CreateManagedServiceReply> {
    this.entry(name)
    await this.locked(() => stopUnit(unitName(name)))
    return { service: await this.get(name), readiness: { ok: true, status: 'skipped', httpStatus: null, error: null } }
  }

  async restart(name: string): Promise<CreateManagedServiceReply> {
    const e = this.entry(name)
    const startError = await this.locked(async () => {
      await stopUnit(unitName(name))
      return this.tryStart(name)
    })
    return this.reply(e, startError)
  }

  async remove(name: string): Promise<void> {
    this.entry(name)
    await this.locked(async () => {
      await this.applyUnits([], [name])
      await this.registry.remove(name)
      await this.removeFiles(name)
      this.spawns.delete(unitName(name))
    })
  }

  async readLogs(name: string, lines: number): Promise<string> {
    this.entry(name)
    try {
      const { stdout } = await run('tail', ['-n', String(lines), logFile(name)], { maxBuffer: 64 * 1024 * 1024 })
      return stdout
    } catch (err) {
      if ((err as NodeJS.ErrnoException & { stderr?: string }).stderr?.includes('No such file')) return ''
      throw err
    }
  }

  /** Log file of a registered service, for the tail socket. */
  logPath(name: string): string {
    this.entry(name)
    return logFile(name)
  }

  /**
   * `.valet/services.yaml` -> registry. Declared services whose spec hash changed
   * (or that were ad-hoc under the same name) are rewritten and restarted;
   * unchanged ones are only started if they are not running; declared-then-removed
   * ones are dropped. Ad-hoc services are not touched.
   */
  async ensure(): Promise<EnsureReply> {
    let text: string
    try {
      text = await readFile(SANDBOX.servicesYaml, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, services: [], error: `no ${SANDBOX.servicesYaml}` }
      throw err
    }
    let declared: Declared[]
    try {
      declared = parseServicesYaml(text, SANDBOX.repo)
      for (const d of declared) {
        this.validateCommand(d.command)
        this.validateEnv(d.env, `services.${d.name}.env`)
      }
    } catch (err) {
      return { ok: false, services: [], error: (err as Error).message }
    }

    let planned: Array<{ entry: RegistryEntry; startError: string | null }>
    try {
      planned = await this.locked(() => this.reconcile(declared))
    } catch (err) {
      // supervisord failures included: ensure runs at boot, where a rejection would take the supervisor down.
      return { ok: false, services: [], error: err instanceof Error ? err.message : String(err) }
    }
    const services = await Promise.all(
      planned.map(async ({ entry: e, startError }) => {
        const r = await this.readiness(e, startError)
        return {
          name: e.name,
          ok: r.ok,
          port: e.port,
          url: this.urlFor(e.port),
          status: r.status,
          ...(r.httpStatus !== null ? { healthStatus: r.httpStatus } : {}),
          ...(r.error !== null ? { healthError: r.error } : {}),
        }
      }),
    )
    return { ok: services.every((s) => s.ok), services }
  }

  private async reconcile(declared: Declared[]): Promise<Array<{ entry: RegistryEntry; startError: string | null }>> {
    // Ports first: URLs must be known before any env referencing them is resolved.
    const taken = new Set(this.registry.portOwners().keys())
    const ports = new Map<string, number | null>()
    for (const d of declared) {
      const port = await this.assignPort(d.name, d.port, wantsPort(d), taken).catch((err: unknown) => {
        throw new EnsureError(`services.${d.name}: ${(err as Error).message}`)
      })
      if (port !== null) taken.add(port)
      ports.set(d.name, port)
    }
    const urls = new Map(declared.map((d) => [d.name, this.urlFor(ports.get(d.name) ?? null)]))
    const stamp = now()
    const planned: Array<{ entry: RegistryEntry; changed: boolean; replaced: boolean }> = []
    for (const d of declared) {
      let env: Record<string, string>
      try {
        env = resolveEnv(d.env, urls)
      } catch (err) {
        throw new EnsureError(`services.${d.name}.${(err as Error).message}`)
      }
      const cwdInfo = await stat(d.cwd).catch(() => null)
      if (!cwdInfo?.isDirectory()) throw new EnsureError(`services.${d.name}.cwd: not a directory: ${d.cwd}`)
      const spec: Spec = { command: d.command, cwd: d.cwd, port: ports.get(d.name) ?? null, env, browser: d.browser, health: d.health, review: d.review }
      const hash = specHash(spec)
      const prev = this.registry.get(d.name)
      const changed = !prev || prev.source !== 'yaml' || prev.specHash !== hash
      planned.push({
        entry: { name: d.name, ...spec, source: 'yaml', specHash: hash, createdAt: prev?.createdAt ?? stamp, updatedAt: changed ? stamp : prev.updatedAt },
        changed,
        replaced: prev !== undefined,
      })
    }

    const declaredNames = new Set(declared.map((d) => d.name))
    const removed = this.registry
      .all()
      .filter((e) => e.source === 'yaml' && !declaredNames.has(e.name))
      .map((e) => e.name)
    const written = planned.filter((p) => p.changed).map((p) => p.entry)
    await this.applyUnits(written, removed)
    for (const name of removed) {
      await this.registry.remove(name)
      await this.removeFiles(name)
      this.spawns.delete(unitName(name))
    }
    for (const entry of written) await this.registry.put(entry)
    const out: Array<{ entry: RegistryEntry; startError: string | null }> = []
    for (const { entry, changed, replaced } of planned) {
      // A changed spec does not change the unit text, so `update` left the old process running.
      if (changed && replaced) await stopUnit(unitName(entry.name))
      out.push({ entry, startError: await this.tryStart(entry.name) })
    }
    return out
  }
}
