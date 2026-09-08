import Docker from 'dockerode'
import type { SandboxImageStatus, SandboxUsage } from '@valet/shared'
import { PORTAL_ENV, SANDBOX } from '@valet/shared'
import type { Config } from '../config.js'
import { statusOf } from '../errors.js'

export const LABEL_MANAGED = 'valet.managed'
export const LABEL_THREAD = 'valet.thread'
export const LABEL_PROJECT = 'valet.project'
export const LABEL_HELPER = 'valet.helper'

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

export type ContainerState = {
  id: string
  running: boolean
  status: string
  ip: string | null
  imageId: string
  /** The kernel OOM-killed something in the container since it started. */
  oomKilled: boolean
  /** Exit status of the last run; 0 while the container has never stopped. */
  exitCode: number
}

/**
 * Whether the container is gone because it exceeded its memory limit. `OOMKilled`
 * alone is not enough: the cgroup is not killed as a group here, so one build step
 * being OOM-killed sets the flag for the rest of that run while the container keeps
 * running (a later `docker start` clears it). Exit 137 is SIGKILL, which is also what
 * a `docker stop` whose timeout expired produces, so the caller must already know the
 * container was not stopped on purpose.
 */
export function diedOfMemory(state: ContainerState): boolean {
  return !state.running && state.oomKilled && state.exitCode === 137
}

type CpuSample = {
  cpu_usage: { total_usage: number; percpu_usage?: number[] }
  system_cpu_usage?: number
  online_cpus?: number
}

/** The parts of a `docker stats` sample that are read here; which ones the daemon sends depends on the cgroup version. */
export type StatsSample = {
  memory_stats: { usage?: number; stats?: { inactive_file?: number; total_inactive_file?: number } }
  cpu_stats: CpuSample
  precpu_stats: CpuSample
}

/**
 * The numbers `docker stats` prints, from one sample. Memory drops the page cache,
 * which `usage` includes (cgroup v1 reports it as `total_inactive_file`, v2 as
 * `inactive_file`): a sandbox that cloned a repo and installed its dependencies would
 * otherwise read near its limit forever, since cache is only reclaimed under pressure.
 */
export function toUsage(s: StatsSample): SandboxUsage {
  const usage = s.memory_stats.usage ?? 0
  const cache = s.memory_stats.stats?.total_inactive_file ?? s.memory_stats.stats?.inactive_file ?? 0
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage
  const systemDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0)
  const cores = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cores * 100 : 0
  return { memoryBytes: cache < usage ? usage - cache : usage, cpuPercent: Math.round(cpuPercent) }
}

/**
 * Capabilities removed from Docker's default set. The rest stay: `apt-get` and its
 * maintainer scripts need CHOWN/DAC_OVERRIDE/FOWNER/FSETID/SETFCAP, `sudo` needs
 * SETUID/SETGID, supervisord needs KILL, dev servers may bind low ports with
 * NET_BIND_SERVICE. Dropping NET_RAW removes raw sockets, so a `ping` installed
 * into a thread will not work.
 *
 * Not set here on purpose: `no-new-privileges` (breaks the `sudo` the agent needs)
 * and a read-only rootfs (`apt-get install` inside a thread is a supported workflow).
 * Blocking the cloud metadata address needs a host rule; see the README.
 */
const CAP_DROP = ['NET_RAW', 'AUDIT_WRITE', 'MKNOD', 'SYS_PTRACE']

const HELPER_MEMORY = 1024 * 1024 * 1024
/** A helper runs one CLI command, never a desktop. */
const HELPER_PIDS = 512

export class DockerClient {
  readonly docker: Docker

  constructor(private readonly cfg: Config) {
    this.docker = cfg.DOCKER_HOST ? new Docker() : new Docker({ socketPath: cfg.DOCKER_SOCKET })
  }

  async ping(): Promise<void> {
    await this.docker.ping()
  }

  get imageName(): string {
    return this.cfg.VALET_SANDBOX_IMAGE
  }

  async imageStatus(): Promise<SandboxImageStatus> {
    const image = this.cfg.VALET_SANDBOX_IMAGE
    try {
      const info = await this.docker.getImage(image).inspect()
      return { image, present: true, imageId: info.Id, createdAt: info.Created }
    } catch (err) {
      if (statusOf(err) === 404) return { image, present: false, imageId: null, createdAt: null }
      throw err
    }
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

  private reposBind(): string {
    return `${this.cfg.VALET_REPOS_VOLUME}:${SANDBOX.reposMount}`
  }

  async createSandbox(spec: SandboxSpec): Promise<string> {
    const name = sandboxName(spec.threadId)
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
        NetworkMode: this.cfg.VALET_DOCKER_NETWORK,
        Binds: [`${spec.volume}:${SANDBOX.home}`, this.reposBind()],
        Memory: this.cfg.VALET_SANDBOX_MEMORY,
        // Equal to Memory means no swap, so a runaway process is OOM-killed instead of thrashing.
        MemorySwap: this.cfg.VALET_SANDBOX_MEMORY,
        NanoCpus: Math.round(this.cfg.VALET_SANDBOX_CPUS * 1e9),
        PidsLimit: this.cfg.VALET_SANDBOX_PIDS,
        CapDrop: CAP_DROP,
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
    const container = await this.docker.createContainer({
      Image: this.cfg.VALET_SANDBOX_IMAGE,
      name,
      Hostname: name,
      Env: [`VALET_SUPERVISOR_TOKEN=${token}`],
      Labels: { [LABEL_HELPER]: 'true' },
      HostConfig: {
        NetworkMode: this.cfg.VALET_DOCKER_NETWORK,
        Memory: HELPER_MEMORY,
        MemorySwap: HELPER_MEMORY,
        NanoCpus: 1e9,
        PidsLimit: HELPER_PIDS,
        CapDrop: CAP_DROP,
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
      const net = info.NetworkSettings.Networks[this.cfg.VALET_DOCKER_NETWORK]
      const ip = net?.IPAddress || Object.values(info.NetworkSettings.Networks)[0]?.IPAddress || null
      return {
        id: info.Id,
        running: info.State.Running,
        status: info.State.Status,
        ip,
        imageId: info.Image,
        oomKilled: info.State.OOMKilled,
        exitCode: info.State.ExitCode,
      }
    } catch (err) {
      if (statusOf(err) === 404) return null
      throw err
    }
  }

  /**
   * One `docker stats` sample. The non-streaming form carries the previous CPU
   * sample too, which is what the percentage is computed against.
   */
  async stats(id: string): Promise<SandboxUsage | null> {
    try {
      return toUsage(await this.docker.getContainer(id).stats({ stream: false }))
    } catch (err) {
      if (statusOf(err) === 404 || statusOf(err) === 409) return null
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
}
