import { StringDecoder } from 'node:string_decoder'
import Docker from 'dockerode'
import type { SandboxImageStatus } from '@valet/shared'
import { PORTAL_ENV, SANDBOX } from '@valet/shared'
import type { Config } from '../config.js'
import { statusOf } from '../errors.js'
import { shortHex } from '../ids.js'

export const LABEL_MANAGED = 'valet.managed'
export const LABEL_THREAD = 'valet.thread'
export const LABEL_PROJECT = 'valet.project'
export const LABEL_HELPER = 'valet.helper'
export const LABEL_SNAPSHOT = 'valet.snapshot'
export const LABEL_KEY = 'valet.key'

/** Only the tail of a copy's output is ever read: the byte count, or the end of an error. */
const COPY_OUTPUT_TAIL = 4096

export const sandboxName = (threadId: string): string => `valet-sandbox-${threadId}`
export const volumeName = (threadId: string): string => `valet-home-${threadId}`
/** `key` is the short snapshot key; the full one is only stored on the project row. */
export const snapshotVolumeName = (projectId: string, key: string): string => `valet-snap-${projectId}-${key}`

export type SandboxSpec = {
  threadId: string
  projectId: string
  token: string
  volume: string
  /** `http://t-<thread>-p{port}.<domain>`, exported to shells in the container. */
  portalUrlTemplate: string
}

export type ContainerState = { id: string; running: boolean; status: string; ip: string | null; imageId: string }

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

  /** The labels of an existing volume, or null when there is no such volume. */
  async volumeLabels(name: string): Promise<Record<string, string> | null> {
    try {
      const info = await this.docker.getVolume(name).inspect()
      return info.Labels ?? {}
    } catch (err) {
      if (statusOf(err) === 404) return null
      throw err
    }
  }

  async volumeExists(name: string): Promise<boolean> {
    return (await this.volumeLabels(name)) !== null
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

  listSnapshotVolumes(): Promise<Docker.VolumeInspectInfo[]> {
    return this.docker.listVolumes({ filters: { label: [`${LABEL_SNAPSHOT}=true`] } }).then((r) => r.Volumes ?? [])
  }

  /**
   * Copies `from` into a new volume `to` and returns its size in bytes. The source is
   * mounted read-only, so a live sandbox keeps its volume intact; the copy runs as root
   * so file ownership survives. Removes `to` again if the copy fails or `signal` aborts.
   */
  async cloneVolume(from: string, to: string, labels: Record<string, string>, signal?: AbortSignal): Promise<number> {
    await this.removeVolume(to)
    await this.docker.createVolume({ Name: to, Labels: { ...labels, [LABEL_MANAGED]: 'true' } })
    try {
      return await this.runCopy(from, to, labels, signal)
    } catch (err) {
      await this.removeVolume(to).catch(() => undefined)
      throw err
    }
  }

  private async runCopy(from: string, to: string, labels: Record<string, string>, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted()
    const container = await this.docker.createContainer({
      Image: this.cfg.VALET_SANDBOX_IMAGE,
      name: `valet-copy-${to}-${shortHex()}`,
      User: '0:0',
      Entrypoint: ['/bin/sh', '-c'],
      // The env file holds the project's decrypted variables and is rewritten on every
      // provision, so no copy of a home volume has any reason to carry it along.
      Cmd: ['cp -a /valet-from/. /valet-to/ && rm -f /valet-to/.valet/env && du -sb /valet-to | cut -f1'],
      // Tty keeps stdout unmultiplexed, so the byte count reads back without demuxing.
      Tty: true,
      Labels: { ...labels, [LABEL_HELPER]: 'true' },
      HostConfig: {
        Binds: [`${from}:/valet-from:ro`, `${to}:/valet-to`],
        NetworkMode: 'none',
        Memory: this.cfg.VALET_SANDBOX_MEMORY,
        NanoCpus: Math.round(this.cfg.VALET_SANDBOX_CPUS * 1e9),
        Init: true,
        RestartPolicy: { Name: 'no' },
        AutoRemove: false,
      },
    })
    try {
      // Attached before the start, and raw thanks to Tty: `logs()` would JSON-parse a bare number.
      const stream = await container.attach({ stream: true, stdout: true, stderr: true })
      const decoder = new StringDecoder('utf8')
      let output = ''
      stream.on('data', (chunk: Buffer) => {
        output = (output + decoder.write(chunk)).slice(-COPY_OUTPUT_TAIL)
      })
      await container.start()
      const { StatusCode } = await waitFor(container, signal)
      const tail = output.trim()
      if (StatusCode !== 0) throw new Error(`copying ${from} exited with ${StatusCode}: ${tail.slice(-500)}`)
      const bytes = Number(tail.split(/\s+/).pop())
      if (!Number.isInteger(bytes)) throw new Error(`copying ${from} reported no size: ${tail.slice(-500)}`)
      return bytes
    } finally {
      await container.remove({ force: true }).catch(() => undefined)
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
      const net = info.NetworkSettings.Networks[this.cfg.VALET_DOCKER_NETWORK]
      const ip = net?.IPAddress || Object.values(info.NetworkSettings.Networks)[0]?.IPAddress || null
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
}

/**
 * `container.wait()`, except that an abort rejects immediately. The caller force-removes
 * the container on the way out, which is what stops the work.
 */
function waitFor(container: Docker.Container, signal?: AbortSignal): Promise<{ StatusCode: number }> {
  const wait = container.wait() as Promise<{ StatusCode: number }>
  if (!signal) return wait
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error)
    // An already-aborted signal never emits the event.
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    void wait.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
