import { parseServiceHost, serviceDomain, serviceHost } from '@valet/shared'
import type { Config } from '../config.js'

/**
 * Service addressing: `${scheme}://t-<thread>-p<port>.<domain>`. The scheme is the
 * one Valet itself is served on; locally `*.localhost` resolves to loopback in
 * browsers without DNS, on a server the operator points a wildcard record at the box.
 */
export class ServiceUrls {
  readonly domain: string
  readonly scheme: 'http' | 'https'
  /**
   * Whether service hosts share a site with the UI host, so cookies flow between
   * them under SameSite=Lax. Subdomains of a real domain do; `*.localhost` does not
   * (every label under `.localhost` is its own site), nor does a separate domain.
   */
  readonly sameSite: boolean

  constructor(cfg: Config) {
    const base = new URL(cfg.VALET_BASE_URL)
    this.domain = serviceDomain({ VALET_SERVICE_DOMAIN: cfg.VALET_SERVICE_DOMAIN, VALET_BASE_URL: cfg.VALET_BASE_URL })
    this.scheme = base.protocol === 'https:' ? 'https' : 'http'
    const serviceHostname = this.domain.replace(/:\d+$/, '')
    this.sameSite = base.hostname !== 'localhost' && (serviceHostname === base.hostname || serviceHostname.endsWith(`.${base.hostname}`))
  }

  get secure(): boolean {
    return this.scheme === 'https'
  }

  host(threadId: string, port: number): string {
    return serviceHost(threadId, port, this.domain)
  }

  origin(threadId: string, port: number): string {
    return `${this.scheme}://${this.host(threadId, port)}`
  }

  /** `http://t-<thread>-p{port}.localhost:3000`, for the agent and sandbox scripts. */
  template(threadId: string): string {
    return `${this.scheme}://t-${threadId}-p{port}.${this.domain}`
  }

  /** Thread and port of a browser-facing host, or null when it is not a service under this domain. */
  parse(host: string): { threadId: string; port: number } | null {
    return parseServiceHost(host, this.domain)
  }
}
