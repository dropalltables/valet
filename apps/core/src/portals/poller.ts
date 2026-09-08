import { SANDBOX } from '@valet/shared'
import type { StoredPortal } from '../db/schema.js'
import type { SupervisorClient } from '../docker/supervisor-client.js'
import { errorMessage, logger } from '../logger.js'

const log = logger('portals')

const POLL_MS = 3_000
/** Re-read `.valet/ports.json` this often even when the port set is unchanged. */
const NAMES_EVERY_POLLS = 10
/** Consecutive failed polls before the supervisor is reported unreachable. */
const UNREACHABLE_AFTER = 3

export type PollerHooks = {
  onChange: (portals: StoredPortal[]) => void
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
 * Asks the supervisor for listening ports every few seconds while a container runs
 * and reports the list whenever it differs from the last one reported. The first
 * poll always reports, so a wake replaces whatever was persisted before the pause.
 */
export class PortalPoller {
  private stopped = false
  private lastReported: string | null = null
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
        log.debug('port poll failed', { id: this.threadId, message: errorMessage(err) })
        this.failures += 1
        if (this.failures === UNREACHABLE_AFTER) this.hooks.onUnreachable()
      }
      await sleep(POLL_MS)
    }
  }

  private async poll(): Promise<void> {
    const { ports } = await this.supervisor.ports()
    const portKey = ports.map((p) => p.port).join(',')
    if (portKey !== this.lastPortKey || this.polls % NAMES_EVERY_POLLS === 0) {
      this.names = parseNames(await this.supervisor.fsRead(SANDBOX.portsFile).catch(() => null))
    }
    this.polls += 1
    this.lastPortKey = portKey
    const portals: StoredPortal[] = ports.map((p) => ({ port: p.port, name: this.names[String(p.port)] ?? null, process: p.process }))
    const key = JSON.stringify(portals)
    if (this.stopped || key === this.lastReported) return
    this.lastReported = key
    this.hooks.onChange(portals)
  }
}
