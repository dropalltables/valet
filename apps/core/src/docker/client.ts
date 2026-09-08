import Docker from 'dockerode'
import type { SandboxImageStatus } from '@valet/shared'
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

export type ContainerState = { id: string; running: boolean; status: string; ip: string | null }

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
        NanoCpus: Math.round(this.cfg.VALET_SANDBOX_CPUS * 1e9),
        ShmSize: 1024 * 1024 * 1024,
        Init: true,
        RestartPolicy: { Name: 'no' },
        AutoRemove: false,
      },
    })
    return container.id
  }

  /** Short-lived container from the sandbox image with no volumes (Codex device login). */
  async createHelper(name: string, token: string): Promise<string> {
    const container = await this.docker.createContainer({
      Image: this.cfg.VALET_SANDBOX_IMAGE,
      name,
      Hostname: name,
      Env: [`VALET_SUPERVISOR_TOKEN=${token}`],
      Labels: { [LABEL_HELPER]: 'true' },
      HostConfig: {
        NetworkMode: this.cfg.VALET_DOCKER_NETWORK,
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

  async inspect(id: string): Promise<ContainerState | null> {
    try {
      const info = await this.docker.getContainer(id).inspect()
      const net = info.NetworkSettings.Networks[this.cfg.VALET_DOCKER_NETWORK]
      const ip = net?.IPAddress || Object.values(info.NetworkSettings.Networks)[0]?.IPAddress || null
      return { id: info.Id, running: info.State.Running, status: info.State.Status, ip }
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
}
