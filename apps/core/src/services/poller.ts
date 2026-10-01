import { SANDBOX, type ManagedService } from '@valet/shared'
import type { StoredService } from '../db/schema.js'
import type { SupervisorClient } from '../docker/supervisor-client.js'
import { errorMessage, logger } from '../logger.js'

const log = logger('services')

const POLL_MS = 3_000
/** Re-read `.valet/ports.json` this often even when the port set is unchanged. */
const NAMES_EVERY_POLLS = 10
/** Consecutive failed polls before the supervisor is reported unreachable. */
const UNREACHABLE_AFTER = 3

export type PollerHooks = {
  /** Pids whose listeners (and their children's) are the agent's own, not the project's. */
  excludePids: () => number[]
  onServices: (services: StoredService[]) => void
  /**
   * Every tick while the sandbox runs (uptime changes every time); `changed` is
   * false when only uptime moved, so the owner can skip persisting.
   */
  onManagedServices: (services: ManagedService[], changed: boolean) => void
  /** The supervisor has not answered for a while; the owner decides whether the container is gone. */
  onUnreachable: () => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function parseNames(raw: Buffer | null): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const names: Record<string, string> = {}
    for (const [port, name] of Object.entries(parsed)) if (typeof name === 'string' && name.trim()) names[port] = name.trim()
    return names
  } catch {
    return {}
  }
}

/**
 * Asks the supervisor for listening ports and managed services every few seconds
 * while a container runs. Services are reported whenever the list differs from the
 * last one reported; services are reported every tick (uptime ticks), flagged when
 * something other than uptime changed. The first poll always reports, so a wake
 * replaces whatever was persisted before the pause.
 */
export class SandboxPoller {
  private stopped = false
  private lastServices: string | null = null
  private lastManagedServices: string | null = null
  private lastPortKey = ''
  private names: Record<string, string> = {}
  private polls = 0
  private failures = 0

  constructor(
    private readonly threadId: string,
    private readonly supervisor: SupervisorClient,
    private readonly hooks: PollerHooks,
  ) {}

  start(): void {
    void this.loop()
  }

  stop(): void {
    this.stopped = true
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.poll()
        this.failures = 0
      } catch (err) {
        log.debug('sandbox poll failed', { id: this.threadId, message: errorMessage(err) })
        this.failures += 1
        if (this.failures === UNREACHABLE_AFTER) this.hooks.onUnreachable()
      }
      await sleep(POLL_MS)
    }
  }

  private async poll(): Promise<void> {
    // /managed-services alone failing (a container from an image without it answers 404) must not stop service detection.
    const [{ ports }, managed] = await Promise.all([
      this.supervisor.ports(this.hooks.excludePids()),
      this.supervisor.managedServices().catch((err: unknown) => {
        log.debug('services poll failed', { id: this.threadId, message: errorMessage(err) })
        return null
      }),
    ])
    const portKey = ports.map((p) => p.port).join(',')
    if (portKey !== this.lastPortKey || this.polls % NAMES_EVERY_POLLS === 0) {
      this.names = parseNames(await this.supervisor.fsRead(SANDBOX.portsFile).catch(() => null))
    }
    this.polls += 1
    this.lastPortKey = portKey
    if (this.stopped) return

    // Managed service name first, then the committed ports.json, else nothing.
    const services: StoredService[] = ports.map((p) => ({ port: p.port, name: p.service ?? this.names[String(p.port)] ?? null, process: p.process }))
    const servicesKey = JSON.stringify(services)
    if (servicesKey !== this.lastServices) {
      this.lastServices = servicesKey
      this.hooks.onServices(services)
    }

    if (managed === null) return
    const managedKey = JSON.stringify(managed.map((s) => ({ ...s, uptimeSeconds: null })))
    const changed = managedKey !== this.lastManagedServices
    this.lastManagedServices = managedKey
    this.hooks.onManagedServices(managed, changed)
  }
}
