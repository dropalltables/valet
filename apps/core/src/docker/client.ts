import os from 'node:os'
import Docker from 'dockerode'
import type { SandboxImageStatus } from '@valet/shared'
import { PORTAL_ENV, SANDBOX } from '@valet/shared'
import type { Config } from '../config.js'
import { statusOf } from '../errors.js'
import { errorMessage, logger } from '../logger.js'

const log = logger('docker')

export const LABEL_MANAGED = 'valet.managed'
export const LABEL_THREAD = 'valet.thread'
export const LABEL_PROJECT = 'valet.project'
export const LABEL_HELPER = 'valet.helper'

/** Networks Docker creates itself; a container is on one of them only when it is on no user network. */
const PREDEFINED_NETWORKS = new Set(['bridge', 'host', 'none'])

const IMAGE_CHECK_INTERVAL_MS = 10 * 60_000

export const sandboxName = (threadId: string): string => `valet-sandbox-${threadId}`
export const volumeName = (threadId: string): string => `valet-home-${threadId}`

export type SandboxSpec = {
  threadId: string
  projectId: string
  token: string
  volume: string
  /** `http://t-<thread>-p{port}.<domain>`, exported to shells in the container. */
  portalUrlTemplate: string
}

export type ContainerState = { id: string; running: boolean; status: string; ip: string | null; imageId: string }

/** One layer of a `docker pull`, as the Engine streams it. */
type PullProgress = { status?: string; id?: string; progressDetail?: { current?: number; total?: number } }

/**
 * The compose project name prefixes the network and volume, and on hosts like Coolify it is a
 * resource UUID nobody can predict, so core reads its own container instead of assuming a name.
 */
export type DockerEnvironment = { network: string; reposVolume: string }

/**
 * The user network core is attached to. Hosts that join every stack to a shared proxy network
 * (Coolify's "connect to predefined network") leave core on two, so its own compose project
 * decides; anything still ambiguous is for the operator to name.
 */
export function soleNetworkName(networks: Record<string, unknown>, sameProject: ReadonlySet<string>): string {
  const attached = Object.keys(networks).filter((name) => !PREDEFINED_NETWORKS.has(name))
  const names = attached.length > 1 ? attached.filter((name) => sameProject.has(name)) : attached
  if (names.length === 1) return names[0]!
  throw new Error(`core is attached to ${attached.length} Docker networks; set VALET_DOCKER_NETWORK`)
}

/**
 * Whether an image reference can only have been built on this host: an unqualified name
 * (`valet-sandbox:latest`) means Docker Hub's `library/`, which the sandbox image never is.
 */
export function isLocallyBuilt(image: string): boolean {
  return !image.includes('/')
}

/** The volume (or host path) behind core's repos mount, which every sandbox mounts too. */
export function reposVolumeName(mounts: Docker.ContainerInspectInfo['Mounts'], reposDir: string): string {
  const mount = mounts.find((m) => m.Destination === reposDir)
  if (!mount) throw new Error(`core has no mount at ${reposDir}; set VALET_REPOS_VOLUME`)
  const name = mount.Type === 'volume' ? mount.Name : mount.Source
  if (!name) throw new Error(`the mount at ${reposDir} has no name; set VALET_REPOS_VOLUME`)
  return name
}

/** Networks belonging to the compose project core itself was deployed by. */
async function projectNetworks(docker: Docker, self: Docker.ContainerInspectInfo): Promise<Set<string>> {
  const project = self.Config.Labels?.['com.docker.compose.project']
  if (!project) return new Set()
  const networks = await docker.listNetworks({ filters: { label: [`com.docker.compose.project=${project}`] } })
  return new Set(networks.map((network) => network.Name))
}

async function discover(docker: Docker, cfg: Config): Promise<DockerEnvironment> {
  const network = cfg.VALET_DOCKER_NETWORK
  const reposVolume = cfg.VALET_REPOS_VOLUME
  if (network && reposVolume) return { network, reposVolume }
  // Docker sets the container hostname to its own short id unless the operator overrides it.
  const self = await docker
    .getContainer(os.hostname())
    .inspect()
    .catch((err: unknown) => {
      throw new Error(
        `core cannot inspect its own container to discover the Docker network and repos volume (${errorMessage(err)}); ` +
          'set VALET_DOCKER_NETWORK and VALET_REPOS_VOLUME',
      )
    })
  return {
    network: network ?? soleNetworkName(self.NetworkSettings.Networks, await projectNetworks(docker, self)),
    reposVolume: reposVolume ?? reposVolumeName(self.Mounts, cfg.VALET_REPOS_DIR),
  }
}

export class DockerClient {
  readonly docker: Docker
  private imageChecker: NodeJS.Timeout | null = null
  private pull: Promise<void> | null = null
  private pullPercent: number | null = null
  private pullError: string | null = null
  private env: DockerEnvironment | null = null
  private discovery: Promise<DockerEnvironment> | null = null

  constructor(private readonly cfg: Config) {
    this.docker = cfg.DOCKER_HOST ? new Docker() : new Docker({ socketPath: cfg.DOCKER_SOCKET })
  }

  async ping(): Promise<void> {
    await this.docker.ping()
  }

  /**
   * The network and repos volume every sandbox needs, memoised. Discovery needs a daemon that
   * answers, so an unreachable one is retried on the next call rather than killing core at boot;
   * a daemon that answers ambiguously throws, and startup is the right place for that to happen.
   */
  async environment(): Promise<DockerEnvironment> {
    if (this.env) return this.env
    this.discovery ??= discover(this.docker, this.cfg)
    try {
      this.env = await this.discovery
      return this.env
    } catch (err) {
      this.discovery = null
      throw err
    }
  }

  get imageName(): string {
    return this.cfg.VALET_SANDBOX_IMAGE
  }

  async imageStatus(): Promise<SandboxImageStatus> {
    const image = this.cfg.VALET_SANDBOX_IMAGE
    const pulling = this.pullPercent
    const pullError = this.pullError
    try {
      const info = await this.docker.getImage(image).inspect()
      return { image, present: true, imageId: info.Id, createdAt: info.Created, pulling, pullError }
    } catch (err) {
      if (statusOf(err) === 404) return { image, present: false, imageId: null, createdAt: null, pulling, pullError }
      throw err
    }
  }

  /** Pulls the sandbox image when it is missing, now and every ten minutes. */
  startImageWatcher(): void {
    if (this.imageChecker) return
    const check = (): void => void this.pullImageIfMissing().catch((err: unknown) => log.error('sandbox image check failed', { err }))
    this.imageChecker = setInterval(check, IMAGE_CHECK_INTERVAL_MS)
    this.imageChecker.unref()
    check()
  }

  /** One pull at a time; every caller waits on the one in flight. */
  private pullImageIfMissing(): Promise<void> {
    this.pull ??= this.pullMissingImage().finally(() => {
      this.pull = null
    })
    return this.pull
  }

  private async pullMissingImage(): Promise<void> {
    const image = this.cfg.VALET_SANDBOX_IMAGE
    const { present } = await this.imageStatus()
    if (present) {
      this.pullError = null
      return
    }
    if (isLocallyBuilt(image)) return
    log.info('pulling sandbox image', { image })
    this.pullPercent = 0
    this.pullError = null
    try {
      await this.pullImage(image)
      log.info('pulled sandbox image', { image })
    } catch (err) {
      this.pullError = errorMessage(err)
      log.error('pulling sandbox image failed', { image, err })
    } finally {
      this.pullPercent = null
    }
  }

  private async pullImage(image: string): Promise<void> {
    const stream = await this.docker.pull(image)
    // One entry per layer and phase (download, extract); layers report progress out of order.
    const phases = new Map<string, { current: number; total: number }>()
    let logged = 0
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event: PullProgress) => {
          if (!event.id || !event.progressDetail?.total) return
          phases.set(`${event.status}:${event.id}`, { current: event.progressDetail.current ?? 0, total: event.progressDetail.total })
          let current = 0
          let total = 0
          for (const phase of phases.values()) {
            current += phase.current
            total += phase.total
          }
          if (total === 0) return
          // Layers that have not started downloading are not in the total yet, so the raw
          // ratio dips as they arrive; report the high-water mark instead of going backwards.
          this.pullPercent = Math.max(this.pullPercent ?? 0, Math.min(100, Math.round((current / total) * 100)))
          if (this.pullPercent >= logged + 10) {
            logged = this.pullPercent - (this.pullPercent % 10)
            log.info('pulling sandbox image', { image, percent: this.pullPercent })
          }
        },
      )
    })
  }

  listManaged(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({ all: true, filters: { label: [`${LABEL_MANAGED}=true`] } })
  }

  listHelpers(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({ all: true, filters: { label: [`${LABEL_HELPER}=true`] } })
  }

  async countRunningSandboxes(): Promise<number> {
    const list = await this.docker.listContainers({
      filters: { label: [`${LABEL_MANAGED}=true`], status: ['running'] },
    })
    return list.length
  }

  async volumeExists(name: string): Promise<boolean> {
    try {
      await this.docker.getVolume(name).inspect()
      return true
    } catch (err) {
      if (statusOf(err) === 404) return false
      throw err
    }
  }

  async ensureVolume(name: string, labels: Record<string, string>): Promise<void> {
    if (await this.volumeExists(name)) return
    await this.docker.createVolume({ Name: name, Labels: { ...labels, [LABEL_MANAGED]: 'true' } })
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).remove()
    } catch (err) {
      if (statusOf(err) !== 404) throw err
    }
  }

  async createSandbox(spec: SandboxSpec): Promise<string> {
    const name = sandboxName(spec.threadId)
    const env = await this.environment()
    const container = await this.docker.createContainer({
      Image: this.cfg.VALET_SANDBOX_IMAGE,
      name,
      Hostname: name,
      Env: [
        `VALET_SUPERVISOR_TOKEN=${spec.token}`,
        `${PORTAL_ENV.threadId}=${spec.threadId}`,
        `${PORTAL_ENV.urlTemplate}=${spec.portalUrlTemplate}`,
      ],
      Labels: { [LABEL_THREAD]: spec.threadId, [LABEL_PROJECT]: spec.projectId, [LABEL_MANAGED]: 'true' },
      HostConfig: {
        NetworkMode: env.network,
        Binds: [`${spec.volume}:${SANDBOX.home}`, `${env.reposVolume}:${SANDBOX.reposMount}`],
        Memory: this.cfg.VALET_SANDBOX_MEMORY,
        NanoCpus: Math.round(this.cfg.VALET_SANDBOX_CPUS * 1e9),
        ShmSize: 1024 * 1024 * 1024,
        Init: true,
        RestartPolicy: { Name: 'no' },
        AutoRemove: false,
      },
    })
    return container.id
  }

  /** Short-lived container from the sandbox image with no volumes (Codex device login, model list refresh). */
  async createHelper(name: string, token: string): Promise<string> {
    const env = await this.environment()
    const container = await this.docker.createContainer({
      Image: this.cfg.VALET_SANDBOX_IMAGE,
      name,
      Hostname: name,
      Env: [`VALET_SUPERVISOR_TOKEN=${token}`],
      Labels: { [LABEL_HELPER]: 'true' },
      HostConfig: {
        NetworkMode: env.network,
        Memory: 1024 * 1024 * 1024,
        NanoCpus: 1e9,
        Init: true,
        RestartPolicy: { Name: 'no' },
        AutoRemove: false,
      },
    })
    return container.id
  }

  async start(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).start()
    } catch (err) {
      // 304: already running.
      if (statusOf(err) !== 304) throw err
    }
  }

  async stop(id: string, seconds = 10): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: seconds })
    } catch (err) {
      // 304: already stopped.
      if (statusOf(err) !== 304 && statusOf(err) !== 404) throw err
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ force: true })
    } catch (err) {
      if (statusOf(err) !== 404) throw err
    }
  }

  /** Whether the container was created from an image other than the one configured now. */
  async imageChanged(state: ContainerState): Promise<boolean> {
    const { imageId } = await this.imageStatus()
    return imageId !== null && imageId !== state.imageId
  }

  async inspect(id: string): Promise<ContainerState | null> {
    try {
      const info = await this.docker.getContainer(id).inspect()
      // Discovery may not have run yet; any address beats failing an inspect over it.
      const own = this.env ? info.NetworkSettings.Networks[this.env.network]?.IPAddress : null
      const ip = own || Object.values(info.NetworkSettings.Networks)[0]?.IPAddress || null
      return { id: info.Id, running: info.State.Running, status: info.State.Status, ip, imageId: info.Image }
    } catch (err) {
      if (statusOf(err) === 404) return null
      throw err
    }
  }

  /**
   * Docker DNS resolves the container name when core is on the same user network
   * (compose); the IP works when core runs on the host during development.
   */
  supervisorCandidates(name: string, state: ContainerState): string[] {
    const urls = [`http://${name}:${SANDBOX.supervisorPort}`]
    if (state.ip) urls.push(`http://${state.ip}:${SANDBOX.supervisorPort}`)
    return urls
  }

  shutdown(): void {
    if (this.imageChecker) clearInterval(this.imageChecker)
    this.imageChecker = null
  }
}
