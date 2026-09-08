import { and, asc, desc, eq, lt, ne, notInArray } from 'drizzle-orm'
import {
  MESSAGEABLE_STATUSES,
  PORTAL_ENV,
  SANDBOX,
  slugify,
  type ChangesResponse,
  type CreatePrRequest,
  type CreateServiceReply,
  type CreateServiceRequest,
  type CreateThreadRequest,
  type FileEntry,
  type FileResponse,
  type FilesResponse,
  type Portal,
  type SendMessageRequest,
  type Service,
  type Thread,
  type ThreadEvent,
  type ThreadListItem,
  type ThreadStatus,
} from '@valet/shared'
import type { WebSocket } from 'ws'
import { ClaudeAdapter } from '../agents/claude.js'
import { CodexAdapter } from '../agents/codex.js'
import { systemPromptSuffix } from '../agents/system-prompt.js'
import type { Adapter, PromptImage } from '../agents/types.js'
import type { Config } from '../config.js'
import type { CredentialStore } from '../credentials/store.js'
import { randomHex, type Cipher } from '../crypto.js'
import type { Db } from '../db/index.js'
import { projects, threads, type PortalShare, type ProjectRow, type StoredPortal, type ThreadRow } from '../db/schema.js'
import { LABEL_THREAD, sandboxName, volumeName, type DockerClient } from '../docker/client.js'
import { waitForSupervisor, type ExecSocket, type SupervisorClient } from '../docker/supervisor-client.js'
import { HttpError, badRequest, conflict, notFound } from '../errors.js'
import type { EventLog } from '../events/log.js'
import { withAskpass } from '../git/askpass.js'
import { computeChanges, git, type GitRunner } from '../git/changes.js'
import { GitHub, cloneUrl, requireRepoRef } from '../git/github.js'
import { newId, shortHex } from '../ids.js'
import type { McpServerStore } from '../mcp/store.js'
import { errorMessage, logger } from '../logger.js'
import { SandboxPoller } from '../portals/poller.js'
import type { PortalUrls } from '../portals/urls.js'
import type { ProjectService } from '../projects/service.js'
import type { SnapshotStore } from '../projects/snapshots.js'
import type { SettingsService } from '../settings.js'
import { titleFromPrompt, toListItem, toPortals, toThread } from './mapper.js'
import {
  cloneRepo,
  fetchBaseKey,
  prepareBranch,
  readSnapshotKey,
  repoExists,
  repoGit,
  resetToFetchHead,
  runResume,
  runServicesEnsure,
  runSetup,
  shortSnapshotKey,
  syncCodexAuth,
  writeClaudeMcpConfig,
  writeCodexHome,
  writeEnvFile,
  type CloneSource,
  type LogSink,
} from './sandbox-ops.js'

const log = logger('threads')

const SUPERVISOR_BOOT_MS = 60_000
const SUPERVISOR_REATTACH_MS = 5_000
const SWEEP_INTERVAL_MS = 60_000
const PR_REFRESH_MS = 60_000
const FILE_CONTENT_LIMIT = 1024 * 1024

type QueuedMessage = { turnId: string; text: string; images: PromptImage[] }

type LiveSandbox = { containerId: string; supervisor: SupervisorClient; exec: ExecSocket | null; poller: SandboxPoller }

/** Where a portal request for a thread should go. */
export type PortalTarget =
  | { kind: 'missing' }
  | { kind: 'stopped'; row: ThreadRow }
  | { kind: 'running'; row: ThreadRow; supervisor: SupervisorClient }

type Live = {
  id: string
  /** Lifecycle lock: provision, wake, pause, archive, delete, and turn starts run one at a time. */
  chain: Promise<void>
  /** Serializes the running <-> waiting flips that adapter callbacks request. */
  statusChain: Promise<void>
  /** Set while provision() holds the lock; delete/archive abort it instead of waiting. */
  provisionAbort: AbortController | null
  sandbox: LiveSandbox | null
  adapter: Adapter | null
  /** Messages waiting for the adapter to finish its current turn, in send order. */
  queue: QueuedMessage[]
  currentTurnId: string | null
  pendingRequests: Map<string, { turnId: string; kind: 'permission' | 'question' }>
  stoppingAdapter: boolean
}

export type ThreadServiceDeps = {
  db: Db
  cfg: Config
  cipher: Cipher
  docker: DockerClient
  events: EventLog
  projects: ProjectService
  snapshots: SnapshotStore
  credentials: CredentialStore
  settings: SettingsService
  portalUrls: PortalUrls
  mcp: McpServerStore
}

const now = (): string => new Date().toISOString()

export class ThreadService {
  private readonly live = new Map<string, Live>()
  private readonly prChecked = new Map<string, number>()
  private sweeper: NodeJS.Timeout | null = null

  private readonly db: Db
  private readonly cfg: Config
  private readonly cipher: Cipher
  private readonly docker: DockerClient
  private readonly events: EventLog
  private readonly projects: ProjectService
  private readonly snapshots: SnapshotStore
  private readonly credentials: CredentialStore
  private readonly settings: SettingsService
  private readonly portalUrls: PortalUrls
  private readonly mcp: McpServerStore

  constructor(deps: ThreadServiceDeps) {
    this.db = deps.db
    this.cfg = deps.cfg
    this.cipher = deps.cipher
    this.docker = deps.docker
    this.events = deps.events
    this.projects = deps.projects
    this.snapshots = deps.snapshots
    this.credentials = deps.credentials
    this.settings = deps.settings
    this.portalUrls = deps.portalUrls
    this.mcp = deps.mcp
  }

  // ---- rows -----------------------------------------------------------------------

  private async row(id: string): Promise<ThreadRow> {
    const [row] = await this.db.select().from(threads).where(eq(threads.id, id))
    if (!row) throw notFound('thread')
    return row
  }

  private async projectName(projectId: string): Promise<string> {
    const [p] = await this.db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId))
    return p?.name ?? ''
  }

  private async listItem(row: ThreadRow): Promise<ThreadListItem> {
    const [projectName, mcpServers] = await Promise.all([this.projectName(row.projectId), this.mcp.countFor(row.projectId)])
    return toListItem(row, projectName, mcpServers)
  }

  private async patch(id: string, set: Partial<ThreadRow>): Promise<ThreadRow> {
    const [row] = await this.db.update(threads).set(set).where(eq(threads.id, id)).returning()
    if (!row) throw notFound('thread')
    this.events.publishThread(await this.listItem(row))
    return row
  }

  private async setStatus(id: string, status: ThreadStatus, detail: string | null = null): Promise<void> {
    const set: Partial<ThreadRow> = { status, error: status === 'error' ? detail : null }
    if (status === 'idle') set.lastActivityAt = new Date()
    await this.patch(id, set)
    await this.events.append(id, { type: 'status', status, detail, at: now() })
  }

  private async fail(id: string, err: unknown): Promise<void> {
    const message = errorMessage(err)
    log.warn('thread failed', { id, message })
    await this.events.append(id, { type: 'error', turnId: null, message, at: now() })
    await this.setStatus(id, 'error', message)
  }

  private liveFor(id: string): Live {
    let live = this.live.get(id)
    if (!live) {
      live = {
        id,
        chain: Promise.resolve(),
        statusChain: Promise.resolve(),
        provisionAbort: null,
        sandbox: null,
        adapter: null,
        queue: [],
        currentTurnId: null,
        pendingRequests: new Map(),
        stoppingAdapter: false,
      }
      this.live.set(id, live)
    }
    return live
  }

  /** Serializes lifecycle operations per thread. */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const live = this.liveFor(id)
    const run = live.chain.then(fn, fn)
    live.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private token(row: ThreadRow): string {
    return this.cipher.decrypt(row.supervisorTokenEnc)
  }

  private sink(id: string): LogSink {
    return (level, message) => void this.events.append(id, { type: 'log', level, message, at: now() })
  }

  /** Project variables plus what scripts and the agent need to print portal URLs. */
  private sandboxEnv(id: string, projectEnv: Record<string, string>): Record<string, string> {
    return { ...projectEnv, [PORTAL_ENV.threadId]: id, [PORTAL_ENV.urlTemplate]: this.portalUrls.template(id) }
  }

  // ---- queries --------------------------------------------------------------------

  async list(archived: boolean): Promise<ThreadListItem[]> {
    const rows = await this.db
      .select({ thread: threads, projectName: projects.name })
      .from(threads)
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .where(archived ? eq(threads.status, 'archived') : ne(threads.status, 'archived'))
      .orderBy(desc(threads.lastActivityAt))
    const mcpCount = await this.mcp.counts()
    return rows.map((r) => toListItem(r.thread, r.projectName, mcpCount(r.thread.projectId)))
  }

  async listForProject(projectId: string): Promise<ThreadRow[]> {
    return this.db.select().from(threads).where(eq(threads.projectId, projectId))
  }

  async get(id: string): Promise<ThreadListItem> {
    let row = await this.row(id)
    row = await this.refreshPr(row)
    return this.listItem(row)
  }

  private async refreshPr(row: ThreadRow): Promise<ThreadRow> {
    if (!row.pr || row.pr.state !== 'open') return row
    const last = this.prChecked.get(row.id) ?? 0
    if (Date.now() - last < PR_REFRESH_MS) return row
    this.prChecked.set(row.id, Date.now())
    try {
      const token = await this.credentials.githubToken()
      if (!token) return row
      const project = await this.projects.getRow(row.projectId)
      const state = await new GitHub(token).pullRequestState(requireRepoRef(project.repoUrl), row.pr.number)
      if (state === row.pr.state) return row
      return await this.patch(row.id, { pr: { ...row.pr, state } })
    } catch (err) {
      log.warn('pull request refresh failed', { id: row.id, err })
      return row
    }
  }

  // ---- create / update / delete ----------------------------------------------------

  async create(req: CreateThreadRequest): Promise<Thread> {
    const project = await this.projects.getRow(req.projectId)
    const prompt = req.prompt.trim()
    if (!prompt) throw badRequest('prompt is required')
    const settings = await this.settings.get()
    const id = newId()
    const [row] = await this.db
      .insert(threads)
      .values({
        id,
        projectId: project.id,
        title: titleFromPrompt(prompt),
        agent: req.agent,
        model: req.model,
        permissions: req.permissions ?? settings.defaultPermissions,
        status: 'provisioning',
        error: null,
        branch: `valet/${slugify(prompt)}-${shortHex()}`,
        baseBranch: req.baseBranch?.trim() || project.defaultBranch,
        containerId: null,
        volumeName: volumeName(id),
        supervisorTokenEnc: this.cipher.encrypt(randomHex(32)),
        agentSessionId: null,
        firstPrompt: prompt,
        repoReady: false,
      })
      .returning()
    if (!row) throw new Error('insert returned no row')
    this.events.publishThread(await this.listItem(row))

    const first: QueuedMessage = { turnId: newId(), text: prompt, images: req.images ?? [] }
    void this.withLock(id, () => this.provision(this.liveFor(id), first)).catch((err) => log.error('provision failed', { id, err }))
    return toThread(row)
  }

  async update(id: string, patch: { title?: string }): Promise<Thread> {
    const set: Partial<ThreadRow> = {}
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw badRequest('title must not be empty')
      set.title = patch.title.trim()
    }
    const row = Object.keys(set).length > 0 ? await this.patch(id, set) : await this.row(id)
    return toThread(row)
  }

  async delete(id: string): Promise<void> {
    await this.row(id)
    this.live.get(id)?.provisionAbort?.abort()
    await this.withLock(id, async () => {
      const live = this.liveFor(id)
      const row = await this.row(id)
      await this.stopAdapter(live)
      this.dropSandbox(live)
      if (row.containerId) await this.docker.remove(row.containerId)
      await this.docker.removeVolume(row.volumeName)
      await this.db.delete(threads).where(eq(threads.id, id))
      this.events.publishThreadDeleted(id)
    })
    this.live.delete(id)
    this.prChecked.delete(id)
  }

  // ---- sandbox lifecycle -----------------------------------------------------------

  private dropSandbox(live: Live): void {
    live.sandbox?.exec?.close()
    live.sandbox?.poller.stop()
    live.sandbox = null
  }

  /** Records a reachable supervisor for the thread and starts watching its ports and services; a previous handle's poller stops first. */
  private attachSandbox(live: Live, containerId: string, supervisor: SupervisorClient): LiveSandbox {
    if (live.sandbox) this.dropSandbox(live)
    const poller = new SandboxPoller(live.id, supervisor, {
      excludePids: () => (live.adapter?.pid == null ? [] : [live.adapter.pid]),
      onPortals: (list) => void this.setPortals(live.id, list),
      onServices: (list, changed) => void this.setServices(live.id, list, changed),
      onUnreachable: () => void this.checkSandbox(live.id).catch((err) => log.warn('sandbox check failed', { id: live.id, err })),
    })
    const sandbox: LiveSandbox = { containerId, supervisor, exec: null, poller }
    live.sandbox = sandbox
    poller.start()
    return sandbox
  }

  /**
   * Called when the live supervisor stopped answering (a portal request or the port
   * poller failed to connect). A Docker round trip decides: a running container whose
   * supervisor answers is a transient failure and keeps its handle; anything else
   * loses the handle, and a container that stopped outside pause() (OOM kill, daemon
   * restart, `docker stop`) leaves the thread paused, so Wake starts it again.
   */
  async checkSandbox(id: string): Promise<void> {
    const live = this.live.get(id)
    const stale = live?.sandbox
    if (!live || !stale) return
    const state = await this.docker.inspect(stale.containerId).catch(() => null)
    const running = state?.running ?? false
    if (running && (await stale.supervisor.health().then(() => true, () => false))) return
    await this.withLock(id, async () => {
      // Whatever held the lock may have re-resolved the sandbox already.
      if (live.sandbox !== stale) return
      log.warn('sandbox stopped answering', { id, running })
      await this.stopAdapter(live)
      this.dropSandbox(live)
      if (running) return
      const row = await this.row(id)
      if (row.status === 'idle' || row.status === 'waiting' || row.status === 'running') await this.setStatus(id, 'paused')
    })
  }

  /** Pauses the least recently active idle threads until one more sandbox may run. */
  private async ensureCapacity(excludeId: string): Promise<void> {
    const tried = [excludeId]
    while ((await this.docker.countRunningSandboxes()) >= this.cfg.VALET_MAX_RUNNING_SANDBOXES) {
      const [candidate] = await this.db
        .select()
        .from(threads)
        .where(and(eq(threads.status, 'idle'), notInArray(threads.id, tried)))
        .orderBy(asc(threads.lastActivityAt))
        .limit(1)
      if (!candidate) throw new Error('No sandbox capacity: every running sandbox is busy')
      tried.push(candidate.id)
      log.info('pausing idle thread for capacity', { paused: candidate.id, for: excludeId })
      const paused = await this.pause(candidate.id)
      // pause() is a no-op when the candidate stopped being idle meanwhile; the loop then picks another.
      if (paused.status !== 'paused') log.info('capacity candidate was no longer idle', { id: candidate.id, status: paused.status })
    }
  }

  /** Container exists, is running, and its supervisor answers. */
  private async ensureSandbox(live: Live, row: ThreadRow, signal?: AbortSignal): Promise<{ sandbox: LiveSandbox; startedNow: boolean }> {
    const token = this.token(row)
    if (live.sandbox) {
      const state = await this.docker.inspect(live.sandbox.containerId)
      if (state?.running) {
        try {
          await live.sandbox.supervisor.health()
          return { sandbox: live.sandbox, startedNow: false }
        } catch {
          // Fall through and re-resolve the address.
        }
      }
      await this.stopAdapter(live)
      this.dropSandbox(live)
    }

    let containerId = row.containerId
    let state = containerId ? await this.docker.inspect(containerId) : null
    // A stopped container from a superseded image would wake with the old supervisor; the volume carries everything that matters.
    if (state && !state.running && (await this.docker.imageChanged(state))) {
      this.sink(row.id)('info', 'Recreating sandbox')
      await this.docker.remove(state.id)
      state = null
    }
    let created = false
    if (!state) {
      await this.ensureCapacity(row.id)
      await this.docker.ensureVolume(row.volumeName, { [LABEL_THREAD]: row.id })
      this.sink(row.id)('info', 'Creating sandbox')
      containerId = await this.docker.createSandbox({
        threadId: row.id,
        projectId: row.projectId,
        token,
        volume: row.volumeName,
        portalUrlTemplate: this.portalUrls.template(row.id),
      })
      await this.patch(row.id, { containerId })
      state = await this.docker.inspect(containerId)
      if (!state) throw new Error('sandbox container disappeared after creation')
      created = true
    }
    let startedNow = false
    if (!state.running) {
      if (!created) {
        this.sink(row.id)('info', 'Starting sandbox')
        await this.ensureCapacity(row.id)
      }
      await this.docker.start(state.id)
      state = (await this.docker.inspect(state.id)) ?? state
      startedNow = true
    }
    const supervisor = await waitForSupervisor(this.docker.supervisorCandidates(sandboxName(row.id), state), token, SUPERVISOR_BOOT_MS, signal)
    return { sandbox: this.attachSandbox(live, state.id, supervisor), startedNow }
  }

  private async ensureExec(live: Live): Promise<ExecSocket> {
    const sandbox = live.sandbox
    if (!sandbox) throw new Error('sandbox is not running')
    if (sandbox.exec && !sandbox.exec.closed) return sandbox.exec
    const exec = await sandbox.supervisor.openExec()
    sandbox.exec = exec
    exec.onClose(() => {
      if (sandbox.exec === exec) sandbox.exec = null
    })
    return exec
  }

  /** Supervisor for a running container, reattaching after a core restart; null when stopped. */
  private async runningSupervisor(id: string): Promise<SupervisorClient | null> {
    const live = this.liveFor(id)
    const row = await this.row(id)
    if (!row.containerId) return null
    const state = await this.docker.inspect(row.containerId)
    if (!state?.running) return null
    if (live.sandbox && live.sandbox.containerId === state.id) return live.sandbox.supervisor
    const supervisor = await waitForSupervisor(
      this.docker.supervisorCandidates(sandboxName(id), state),
      this.token(row),
      SUPERVISOR_REATTACH_MS,
    )
    this.attachSandbox(live, state.id, supervisor)
    return supervisor
  }

  /**
   * Clone, branch, `.valet/setup`, then the first turn. Runs under the lock; the
   * clone and setup can take many minutes, so delete/archive abort it via
   * `live.provisionAbort` rather than queueing behind it.
   */
  private async provision(live: Live, first: QueuedMessage | null): Promise<void> {
    const id = live.id
    const abort = new AbortController()
    const { signal } = abort
    live.provisionAbort = abort
    try {
      await this.setStatus(id, 'provisioning')
      const row = await this.row(id)
      const project = await this.projects.getRow(row.projectId)
      // Before the container exists: the snapshot becomes the thread's home volume, or is
      // already there from an attempt that failed after restoring it.
      const restored = await this.snapshots.restore(project, row, signal)
      const { sandbox } = await this.ensureSandbox(live, row, signal)
      const exec = await this.ensureExec(live)
      const projectEnv = this.sandboxEnv(id, await this.projects.decryptedEnv(project.id))
      const sink = this.sink(id)

      const source: CloneSource =
        project.source === 'github'
          ? { kind: 'github', url: cloneUrl(requireRepoRef(project.repoUrl)), token: await this.credentials.githubToken() }
          : { kind: 'blank', path: `${SANDBOX.reposMount}/${project.id}.git` }
      const run = repoGit(sandbox.supervisor, {}, signal)
      const snapshotKey =
        restored === null ? null : await this.useSnapshot({ row, project, restored, source, supervisor: sandbox.supervisor, run, sink, signal })
      if (snapshotKey === null && (restored !== null || !(await repoExists(sandbox.supervisor)))) {
        sink('info', 'Cloning repository')
        await cloneRepo(sandbox.supervisor, source, row.baseBranch, signal)
      }
      await prepareBranch(run, row.branch)
      await writeEnvFile(sandbox.supervisor, projectEnv)
      signal.throwIfAborted()
      if (snapshotKey === null) {
        const setup = await runSetup(sandbox.supervisor, exec, projectEnv, sink, signal)
        if (project.hasSetupScript !== setup.ran) await this.projects.setHasSetupScript(project.id, setup.ran)
        signal.throwIfAborted()
        // Before services start and before the first turn: nothing is writing to the volume yet.
        if (setup.ran && setup.ok) {
          await this.snapshots.capture(project, await readSnapshotKey(run, 'HEAD', row.baseBranch), row.baseBranch, row.volumeName, signal)
        }
      } else {
        await runResume(sandbox.supervisor, exec, projectEnv, sink)
      }
      signal.throwIfAborted()
      await runServicesEnsure(sandbox.supervisor, exec, sink, signal)
      signal.throwIfAborted()
      await this.patch(id, { repoReady: true })
      await this.setStatus(id, 'idle')
      if (first) await this.enqueueTurn(live, first)
    } catch (err) {
      // Aborted means delete/archive is next in the lock chain and owns the row from here.
      if (signal.aborted) log.info('provisioning aborted', { id })
      else await this.fail(id, err)
    } finally {
      if (live.provisionAbort === abort) live.provisionAbort = null
    }
  }

  /**
   * Brings a restored snapshot up to the base branch head, or returns null when it no
   * longer fits the repository, which also invalidates it for the project. The caller
   * clones fresh in that case.
   */
  private async useSnapshot(ctx: {
    row: ThreadRow
    project: ProjectRow
    restored: string
    source: CloneSource
    supervisor: SupervisorClient
    run: GitRunner
    sink: LogSink
    signal: AbortSignal
  }): Promise<string | null> {
    const { row, project, restored, source, supervisor, run, sink, signal } = ctx
    try {
      const key = await fetchBaseKey(supervisor, source, row.baseBranch, signal)
      if (key !== restored) {
        sink('info', 'Snapshot is out of date')
        // Only if the project still points at what this thread restored: another thread
        // may have captured a current snapshot while this one was retrying.
        if (project.snapshotKey === restored) await this.snapshots.drop(project.id, 'setup or lockfiles changed at base head')
        return null
      }
      await resetToFetchHead(run, row.baseBranch)
      sink('info', `Started from snapshot ${shortSnapshotKey(key)}`)
      return key
    } catch (err) {
      signal.throwIfAborted()
      log.warn('starting from snapshot failed', { id: row.id, err: errorMessage(err) })
      return null
    }
  }

  private async wakeLive(live: Live): Promise<void> {
    const id = live.id
    const row = await this.row(id)
    const { sandbox, startedNow } = await this.ensureSandbox(live, row)
    if (startedNow) {
      const exec = await this.ensureExec(live)
      const projectEnv = this.sandboxEnv(id, await this.projects.decryptedEnv(row.projectId))
      await writeEnvFile(sandbox.supervisor, projectEnv)
      await runResume(sandbox.supervisor, exec, projectEnv, this.sink(id))
      await runServicesEnsure(sandbox.supervisor, exec, this.sink(id))
    }
    if (row.status === 'paused' || row.status === 'error') await this.setStatus(id, 'idle')
  }

  async wake(id: string): Promise<Thread> {
    const row = await this.row(id)
    if (row.status === 'archived') throw conflict('thread is archived')
    await this.withLock(id, async () => {
      // Whatever held the lock (a provision, a turn start) may have changed the status.
      const current = await this.row(id)
      if (current.status !== 'paused' && current.status !== 'error') return
      const live = this.liveFor(id)
      if (!current.repoReady) {
        await this.provision(live, null)
        return
      }
      try {
        await this.wakeLive(live)
      } catch (err) {
        await this.fail(id, err)
      }
    })
    return toThread(await this.row(id))
  }

  async pause(id: string): Promise<Thread> {
    // A provisioning thread is not pausable; answer now instead of waiting out the clone.
    if (this.live.get(id)?.provisionAbort) return toThread(await this.row(id))
    return this.withLock(id, async () => {
      const live = this.liveFor(id)
      const row = await this.row(id)
      if (row.status !== 'idle' && row.status !== 'waiting') return toThread(row)
      await this.stopAdapter(live)
      this.dropSandbox(live)
      if (row.containerId) await this.docker.stop(row.containerId)
      await this.setStatus(id, 'paused')
      return toThread(await this.row(id))
    })
  }

  async archive(id: string): Promise<Thread> {
    this.live.get(id)?.provisionAbort?.abort()
    return this.withLock(id, async () => {
      const live = this.liveFor(id)
      const row = await this.row(id)
      if (row.status === 'archived') return toThread(row)
      await this.stopAdapter(live)
      this.dropSandbox(live)
      live.queue = []
      if (row.containerId) await this.docker.remove(row.containerId)
      await this.patch(id, { containerId: null, archivedAt: new Date() })
      await this.setStatus(id, 'archived')
      return toThread(await this.row(id))
    })
  }

  async unarchive(id: string): Promise<Thread> {
    return this.withLock(id, async () => {
      const row = await this.row(id)
      if (row.status !== 'archived') return toThread(row)
      await this.patch(id, { archivedAt: null })
      await this.setStatus(id, row.repoReady ? 'paused' : 'error', row.repoReady ? null : 'Provisioning did not finish')
      return toThread(await this.row(id))
    })
  }

  // ---- agent process -----------------------------------------------------------------

  private async launchAdapter(live: Live, row: ThreadRow): Promise<Adapter> {
    const sandbox = live.sandbox
    if (!sandbox) throw new Error('sandbox is not running')
    const exec = await this.ensureExec(live)
    const env: Record<string, string> = { ...this.sandboxEnv(row.id, await this.projects.decryptedEnv(row.projectId)), HOME: SANDBOX.home }

    const mcpServers = await this.mcp.forProject(row.projectId)

    let adapter: Adapter
    let mcpConfigPath: string | null = null
    if (row.agent === 'claude') {
      const cred = await this.credentials.claudeEnv()
      if (!cred) throw new Error('No Claude Code credential is configured. Add one in Settings.')
      Object.assign(env, cred, { CLAUDE_CONFIG_DIR: SANDBOX.claudeConfigDir })
      const { allowProjectMcpJson } = await this.settings.get()
      mcpConfigPath = await writeClaudeMcpConfig(sandbox.supervisor, mcpServers, allowProjectMcpJson, this.sink(row.id))
      adapter = new ClaudeAdapter()
    } else {
      const auth = await this.credentials.codexAuth()
      if (!auth) throw new Error('No Codex credential is configured. Add one in Settings.')
      env.CODEX_HOME = SANDBOX.codexHome
      if (auth.mode === 'api-key') {
        env.CODEX_API_KEY = auth.apiKey
        await writeCodexHome(sandbox.supervisor, null, mcpServers)
      } else {
        await writeCodexHome(sandbox.supervisor, auth.authJson, mcpServers)
      }
      adapter = new CodexAdapter()
    }

    live.adapter = adapter
    const id = row.id
    await adapter.start({
      runner: exec,
      cwd: SANDBOX.repo,
      model: row.model,
      permissions: row.permissions,
      env,
      resumeSessionId: row.agentSessionId,
      mcpConfigPath,
      systemPromptSuffix: systemPromptSuffix({
        branch: row.branch,
        baseBranch: row.baseBranch,
        portalUrlTemplate: this.portalUrls.template(row.id),
      }),
      onEvent: (event) => this.onAdapterEvent(live, event),
      onSessionId: (sessionId) => {
        if (sessionId === row.agentSessionId) return
        row.agentSessionId = sessionId
        void this.patch(id, { agentSessionId: sessionId })
          .then(() => this.events.append(id, { type: 'session', agentSessionId: sessionId }))
          .catch((err) => log.warn('failed to store session id', { id, err }))
      },
      onExit: (info) => void this.onAdapterExit(live, adapter, info),
    })
    return adapter
  }

  private onAdapterEvent(live: Live, event: ThreadEvent): void {
    const id = live.id
    void this.events.append(id, event)
    switch (event.type) {
      case 'permission.request':
        live.pendingRequests.set(event.requestId, { turnId: event.turnId, kind: 'permission' })
        this.syncWaiting(live)
        return
      case 'question.request':
        live.pendingRequests.set(event.requestId, { turnId: event.turnId, kind: 'question' })
        this.syncWaiting(live)
        return
      case 'permission.response':
      case 'question.response':
        live.pendingRequests.delete(event.requestId)
        this.syncWaiting(live)
        return
      case 'turn.end':
        void this.afterTurn(live, event).catch((err) => log.error('post-turn handling failed', { id, err }))
        return
      default:
        return
    }
  }

  /**
   * Flips running <-> waiting as requests open and close. The target is computed
   * when the update runs, and the UPDATE is conditional on the row still being in
   * the other of the two states, so a late flip can never overwrite idle/paused/error
   * written by the lock holder.
   */
  private syncWaiting(live: Live): void {
    const id = live.id
    live.statusChain = live.statusChain
      .then(async () => {
        if (live.stoppingAdapter || live.currentTurnId === null) return
        const target: ThreadStatus = live.pendingRequests.size > 0 ? 'waiting' : 'running'
        const from: ThreadStatus = target === 'waiting' ? 'running' : 'waiting'
        const [row] = await this.db
          .update(threads)
          .set({ status: target, error: null })
          .where(and(eq(threads.id, id), eq(threads.status, from)))
          .returning()
        if (!row) return
        this.events.publishThread(await this.listItem(row))
        await this.events.append(id, { type: 'status', status: target, detail: null, at: now() })
      })
      .catch((err) => log.warn('status update failed', { id, err }))
  }

  private async afterTurn(live: Live, event: Extract<ThreadEvent, { type: 'turn.end' }>): Promise<void> {
    const id = live.id
    if (live.currentTurnId === event.turnId) live.currentTurnId = null
    live.pendingRequests.clear()
    if (live.stoppingAdapter) return
    const row = await this.row(id)
    const set: Partial<ThreadRow> = { lastActivityAt: new Date() }
    if (event.usage?.costUsd) set.costUsd = (row.costUsd ?? 0) + event.usage.costUsd
    await this.patch(id, set)

    const supervisor = live.sandbox?.supervisor
    if (supervisor) {
      if (row.agent === 'codex') await syncCodexAuth(supervisor, this.credentials).catch((err) => log.warn('codex auth sync failed', { id, err }))
      await this.refreshDiffStats(id, supervisor, row.baseBranch)
    }

    // The bookkeeping above is slow; by now sendMessage may have started the next
    // turn, so the idle decision is taken under the lock against live state.
    await this.withLock(id, async () => {
      if (!live.adapter?.started) return
      await this.drainQueue(live)
      if (live.currentTurnId !== null || live.adapter?.busy) return
      const fresh = await this.row(id)
      if (fresh.status === 'running' || fresh.status === 'waiting') await this.setStatus(id, 'idle')
    })
  }

  private async onAdapterExit(live: Live, adapter: Adapter, info: { code: number | null; signal: string | null; duringTurn: boolean }): Promise<void> {
    if (live.adapter !== adapter) return
    live.adapter = null
    live.currentTurnId = null
    live.pendingRequests.clear()
    if (live.stoppingAdapter) return
    const id = live.id
    const message = `Agent process exited (code ${info.code ?? 'null'}${info.signal ? `, signal ${info.signal}` : ''})`
    await this.events.append(id, { type: 'log', level: info.duringTurn ? 'error' : 'warn', message, at: now() })
    if (info.duringTurn) await this.setStatus(id, 'error', message)
  }

  /** Ends the CLI process; in-flight turns are recorded as interrupted. */
  private async stopAdapter(live: Live): Promise<void> {
    const adapter = live.adapter
    if (!adapter) return
    live.stoppingAdapter = true
    try {
      const turnId = live.currentTurnId
      for (const [requestId, req] of live.pendingRequests) {
        if (req.kind === 'permission') {
          await this.events.append(live.id, { type: 'permission.response', turnId: req.turnId, requestId, decision: 'deny', by: 'system' })
        }
      }
      live.pendingRequests.clear()
      await adapter.stop().catch((err) => log.warn('adapter stop failed', { id: live.id, err }))
      if (turnId) {
        await this.events.append(live.id, { type: 'turn.end', turnId, status: 'interrupted', error: null, usage: null, at: now() })
      }
    } finally {
      live.adapter = null
      live.currentTurnId = null
      live.stoppingAdapter = false
    }
  }

  private async refreshDiffStats(id: string, supervisor: SupervisorClient, baseBranch: string): Promise<void> {
    try {
      const changes = await computeChanges(repoGit(supervisor, {}), baseBranch)
      await this.patch(id, { diffStats: changes.stats })
    } catch (err) {
      log.debug('diff stats unavailable', { id, message: errorMessage(err) })
    }
  }

  // ---- turns -----------------------------------------------------------------------------

  /** Queues a message and starts it if nothing is running. Always under the lock. */
  private async enqueueTurn(live: Live, msg: QueuedMessage): Promise<void> {
    live.queue.push(msg)
    await this.drainQueue(live)
  }

  /** Starts the oldest queued message unless a turn is in flight. Always under the lock. */
  private async drainQueue(live: Live): Promise<void> {
    if (live.adapter?.busy) return
    const next = live.queue.shift()
    if (next) await this.runTurn(live, next)
  }

  private async runTurn(live: Live, msg: QueuedMessage): Promise<void> {
    const id = live.id
    await this.events.append(id, { type: 'turn.start', turnId: msg.turnId, prompt: { text: msg.text, images: msg.images }, mode: 'queue', at: now() })
    try {
      const row = await this.row(id)
      const adapter = live.adapter?.started ? live.adapter : await this.launchAdapter(live, row)
      live.currentTurnId = msg.turnId
      await this.setStatus(id, 'running')
      await adapter.sendTurn(msg.turnId, msg.text, msg.images, 'queue')
    } catch (err) {
      const message = errorMessage(err)
      live.currentTurnId = null
      await this.events.append(id, { type: 'error', turnId: msg.turnId, message, at: now() })
      await this.events.append(id, { type: 'turn.end', turnId: msg.turnId, status: 'failed', error: message, usage: null, at: now() })
      await this.setStatus(id, 'error', message)
    }
  }

  async sendMessage(id: string, req: SendMessageRequest): Promise<{ turnId: string }> {
    const row = await this.row(id)
    if (!MESSAGEABLE_STATUSES.includes(row.status)) throw conflict(`thread is ${row.status}`)
    const text = req.text.trim()
    if (!text && (req.images?.length ?? 0) === 0) throw badRequest('text is required')
    const msg: QueuedMessage = { turnId: newId(), text, images: req.images ?? [] }
    const mode = req.mode ?? 'queue'

    void this.withLock(id, async () => {
      const live = this.liveFor(id)
      try {
        const current = await this.row(id)
        if (current.status === 'archived') return
        if (!current.repoReady) {
          await this.provision(live, msg)
          return
        }
        await this.wakeLive(live)
        const adapter = live.adapter
        if (mode === 'steer' && adapter?.started && adapter.busy && adapter.supportsSteer) {
          await this.events.append(id, { type: 'turn.start', turnId: msg.turnId, prompt: { text, images: msg.images }, mode: 'steer', at: now() })
          await adapter.sendTurn(msg.turnId, text, msg.images, 'steer')
          await this.patch(id, { lastActivityAt: new Date() })
          return
        }
        await this.enqueueTurn(live, msg)
      } catch (err) {
        await this.fail(id, err)
      }
    }).catch((err) => log.error('sendMessage failed', { id, err }))

    return { turnId: msg.turnId }
  }

  async interrupt(id: string): Promise<void> {
    await this.row(id)
    const live = this.live.get(id)
    if (live?.adapter?.busy) await live.adapter.interrupt()
  }

  async answerPermission(id: string, requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    await this.row(id)
    const live = this.live.get(id)
    const pending = live?.pendingRequests.get(requestId)
    if (!live?.adapter || !pending || pending.kind !== 'permission') throw notFound('permission request')
    await live.adapter.answerPermission(requestId, decision)
  }

  async answerQuestion(id: string, requestId: string, answers: Record<string, string[]>): Promise<void> {
    await this.row(id)
    const live = this.live.get(id)
    const pending = live?.pendingRequests.get(requestId)
    if (!live?.adapter || !pending || pending.kind !== 'question') throw notFound('question')
    await live.adapter.answerQuestion(requestId, answers)
  }

  // ---- sandbox views -------------------------------------------------------------------------

  private async requireRunning(id: string): Promise<{ row: ThreadRow; supervisor: SupervisorClient }> {
    const row = await this.row(id)
    const supervisor = await this.runningSupervisor(id)
    if (!supervisor) throw new HttpError(409, 'paused')
    return { row, supervisor }
  }

  async changes(id: string): Promise<ChangesResponse> {
    const { row, supervisor } = await this.requireRunning(id)
    const result = await computeChanges(repoGit(supervisor, {}), row.baseBranch)
    await this.patch(id, { diffStats: result.stats })
    return result
  }

  private repoPath(rel: string): { abs: string; rel: string } {
    const parts = rel.split('/').filter((p) => p && p !== '.')
    if (parts.some((p) => p === '..')) throw badRequest('path must stay inside the repository')
    if (parts[0] === '.git') throw notFound('path')
    const clean = parts.join('/')
    return { abs: clean ? `${SANDBOX.repo}/${clean}` : SANDBOX.repo, rel: clean }
  }

  async files(id: string, path: string): Promise<FilesResponse> {
    const { abs, rel } = this.repoPath(path)
    const { supervisor } = await this.requireRunning(id)
    const reply = await supervisor.fsList(abs)
    if (!reply) throw notFound('directory')
    const entries: FileEntry[] = reply.entries
      .filter((e) => !(rel === '' && e.name === '.git'))
      .map(
        (e): FileEntry => ({
          name: e.name,
          path: rel ? `${rel}/${e.name}` : e.name,
          kind: e.kind === 'dir' ? 'dir' : 'file',
          size: e.size,
        }),
      )
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    return { path: rel, entries }
  }

  async file(id: string, path: string): Promise<FileResponse> {
    const { abs, rel } = this.repoPath(path)
    if (!rel) throw badRequest('path is required')
    const { supervisor } = await this.requireRunning(id)
    let raw: Buffer | null
    try {
      raw = await supervisor.fsRead(abs)
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) {
        const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
        const listing = await supervisor.fsList(parent ? `${SANDBOX.repo}/${parent}` : SANDBOX.repo)
        const entry = listing?.entries.find((e) => e.name === rel.slice(rel.lastIndexOf('/') + 1))
        return { path: rel, content: null, truncated: true, binary: false, size: entry?.size ?? 0 }
      }
      throw err
    }
    if (!raw) throw notFound('file')
    const binary = raw.subarray(0, 8000).includes(0)
    if (binary) return { path: rel, content: null, truncated: false, binary: true, size: raw.length }
    const truncated = raw.length > FILE_CONTENT_LIMIT
    return { path: rel, content: (truncated ? raw.subarray(0, FILE_CONTENT_LIMIT) : raw).toString('utf8'), truncated, binary: false, size: raw.length }
  }

  /** Upstream socket for the pty/vnc relays; 409 when the container is not running. */
  async openRelay(id: string, kind: 'pty' | 'vnc'): Promise<WebSocket> {
    const { supervisor } = await this.requireRunning(id)
    return supervisor.openSocket(`/${kind}`)
  }

  // ---- services ----------------------------------------------------------------------------

  /** Persists only material changes; uptime ticks are published without a write. */
  private async setServices(id: string, services: Service[], changed: boolean): Promise<void> {
    if (!changed) {
      this.events.publishServices(id, services)
      return
    }
    try {
      const [row] = await this.db.update(threads).set({ services }).where(eq(threads.id, id)).returning()
      if (row) this.events.publishServices(id, row.services ?? [])
    } catch (err) {
      log.warn('failed to store services', { id, err })
    }
  }

  /** Last known managed services; the list persists while the container is paused. */
  async services(id: string): Promise<Service[]> {
    return (await this.row(id)).services ?? []
  }

  private async refreshServices(id: string, supervisor: SupervisorClient): Promise<void> {
    const services = await supervisor.services().catch(() => null)
    if (services) await this.setServices(id, services, true)
  }

  async createService(id: string, req: CreateServiceRequest): Promise<CreateServiceReply> {
    const { supervisor } = await this.requireRunning(id)
    const reply = await supervisor.createService(req)
    await this.refreshServices(id, supervisor)
    return reply
  }

  async serviceAction(id: string, name: string, action: 'start' | 'stop' | 'restart'): Promise<CreateServiceReply> {
    const { supervisor } = await this.requireRunning(id)
    const reply = await supervisor.serviceAction(name, action)
    await this.refreshServices(id, supervisor)
    return reply
  }

  async removeService(id: string, name: string): Promise<void> {
    const { supervisor } = await this.requireRunning(id)
    await supervisor.removeService(name)
    await this.refreshServices(id, supervisor)
  }

  async serviceLogs(id: string, name: string, lines: number): Promise<string> {
    const { supervisor } = await this.requireRunning(id)
    return supervisor.serviceLogs(name, lines)
  }

  /** Upstream socket for the log tail relay; 409 when the container is not running. */
  async openServiceLogs(id: string, name: string, lines: number): Promise<WebSocket> {
    const { supervisor } = await this.requireRunning(id)
    return supervisor.openSocket(supervisor.serviceLogsPath(name, lines))
  }

  // ---- portals -----------------------------------------------------------------------------

  private async setPortals(id: string, portals: StoredPortal[]): Promise<void> {
    try {
      const [row] = await this.db.update(threads).set({ portals }).where(eq(threads.id, id)).returning()
      if (row) this.events.publishPortals(id, toPortals(row, this.portalUrls))
    } catch (err) {
      log.warn('failed to store portals', { id, err })
    }
  }

  /** Last known listening ports, with URLs; the list persists while the container is paused. */
  async portals(id: string): Promise<Portal[]> {
    return toPortals(await this.row(id), this.portalUrls)
  }

  /**
   * Resolves a portal request. The supervisor handle attached to the live thread is
   * trusted without a Docker round trip: portal pages fetch dozens of assets, and a
   * container that died since is reported by the proxy as unreachable anyway.
   */
  async portalTarget(id: string): Promise<PortalTarget> {
    let row: ThreadRow
    try {
      row = await this.row(id)
    } catch {
      return { kind: 'missing' }
    }
    if (row.status === 'archived') return { kind: 'missing' }
    const live = this.live.get(id)
    if (live?.sandbox && live.sandbox.containerId === row.containerId) return { kind: 'running', row, supervisor: live.sandbox.supervisor }
    const supervisor = await this.runningSupervisor(id).catch(() => null)
    return supervisor ? { kind: 'running', row, supervisor } : { kind: 'stopped', row }
  }

  async shareState(id: string): Promise<{ shared: boolean; generation: number }> {
    const row = await this.row(id)
    return { shared: row.shared, generation: row.shareGeneration }
  }

  async setShare(id: string, state: { shared: boolean; generation: number }): Promise<void> {
    await this.db.update(threads).set({ shared: state.shared, shareGeneration: state.generation }).where(eq(threads.id, id))
  }

  async portalShare(id: string, port: number): Promise<PortalShare> {
    const row = await this.row(id)
    return row.portalShares?.[String(port)] ?? { generation: 0, expiresAt: null }
  }

  async setPortalShare(id: string, port: number, share: PortalShare): Promise<void> {
    const row = await this.row(id)
    const portalShares = { ...(row.portalShares ?? {}), [String(port)]: share }
    const [updated] = await this.db.update(threads).set({ portalShares }).where(eq(threads.id, id)).returning()
    if (updated) this.events.publishPortals(id, toPortals(updated, this.portalUrls))
  }

  // ---- git: push and pull requests ---------------------------------------------------------------

  async push(id: string): Promise<{ branch: string }> {
    const { row, supervisor } = await this.requireRunning(id)
    const project = await this.projects.getRow(row.projectId)
    const token = project.source === 'github' ? await this.credentials.githubToken() : null
    if (project.source === 'github' && !token) throw badRequest('No GitHub credential is configured')
    const run = repoGit(supervisor, {})
    await git(run, ['add', '-A'])
    const staged = await run(['git', 'diff', '--cached', '--quiet'])
    if (staged.code === 1) await git(run, ['commit', '-m', `valet: ${row.title}`])
    await withAskpass(supervisor, token, (env) => git(run, ['push', '-u', 'origin', row.branch], { env, timeoutMs: 5 * 60_000 }))
    await this.patch(id, { lastActivityAt: new Date() })
    return { branch: row.branch }
  }

  async createPr(id: string, req: CreatePrRequest): Promise<Thread> {
    const row = await this.row(id)
    const project = await this.projects.getRow(row.projectId)
    if (project.source !== 'github') throw badRequest('blank projects have no GitHub repository')
    if (row.pr) throw conflict('a pull request already exists for this thread')
    const token = await this.credentials.githubToken()
    if (!token) throw badRequest('No GitHub credential is configured')
    await this.push(id)
    const ref = requireRepoRef(project.repoUrl)
    const body = req.body ?? `${row.firstPrompt}\n\nOpened from Valet: ${this.cfg.VALET_BASE_URL}/threads/${row.id}`
    const pr = await new GitHub(token).createPullRequest(ref, {
      head: row.branch,
      base: row.baseBranch,
      title: req.title?.trim() || row.title,
      body,
      draft: req.draft ?? false,
    })
    const updated = await this.patch(id, { pr: { url: pr.url, number: pr.number, state: 'open' } })
    return toThread(updated)
  }

  // ---- housekeeping ------------------------------------------------------------------------------

  /** Aligns thread rows with the containers Docker actually has after a core restart. */
  async reconcile(): Promise<void> {
    const containers = await this.docker.listManaged()
    const byThread = new Map(containers.map((c) => [c.Labels[LABEL_THREAD] ?? '', c]))
    const rows = await this.db.select().from(threads)
    for (const row of rows) {
      if (row.status === 'archived') continue
      const c = byThread.get(row.id)
      byThread.delete(row.id)
      let status: ThreadStatus
      let detail: string | null = null
      let containerId: string | null = null
      if (c) {
        containerId = c.Id
        if (!row.repoReady) {
          status = 'error'
          detail = 'Provisioning was interrupted by a restart'
        } else status = c.State === 'running' ? 'idle' : 'paused'
      } else if (!(await this.docker.volumeExists(row.volumeName))) {
        status = 'error'
        detail = 'Sandbox volume is missing'
      } else if (!row.repoReady) {
        status = 'error'
        detail = 'Provisioning was interrupted by a restart'
      } else status = 'paused'

      if (containerId !== row.containerId) await this.patch(row.id, { containerId })
      await this.closeOpenTurn(row.id)
      if (status !== row.status || detail !== row.error) {
        log.info('reconciled thread', { id: row.id, from: row.status, to: status })
        await this.setStatus(row.id, status, detail ?? 'Recovered after restart')
      }
      if (status === 'idle') await this.runningSupervisor(row.id).catch((err) => log.warn('reattach failed', { id: row.id, err }))
    }
    for (const c of byThread.values()) log.warn('managed container without a thread', { id: c.Id, names: c.Names })
  }

  /** A turn that was in flight when the previous core process stopped never got its turn.end. */
  private async closeOpenTurn(id: string): Promise<void> {
    const open = await this.events.openTurn(id)
    if (!open) return
    log.info('closing turn left open by restart', { id, turnId: open.turnId })
    for (const requestId of open.pendingPermissions) {
      await this.events.append(id, { type: 'permission.response', turnId: open.turnId, requestId, decision: 'deny', by: 'system' })
    }
    await this.events.append(id, { type: 'turn.end', turnId: open.turnId, status: 'interrupted', error: 'Core restarted', usage: null, at: now() })
  }

  startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => void this.sweepIdle().catch((err) => log.error('idle sweep failed', { err })), SWEEP_INTERVAL_MS)
    this.sweeper.unref()
  }

  private async sweepIdle(): Promise<void> {
    const settings = await this.settings.get()
    const cutoff = new Date(Date.now() - settings.idlePauseMinutes * 60_000)
    const rows = await this.db
      .select()
      .from(threads)
      .where(and(eq(threads.status, 'idle'), lt(threads.lastActivityAt, cutoff)))
    for (const row of rows) {
      log.info('pausing idle thread', { id: row.id })
      await this.pause(row.id).catch((err) => log.warn('pause failed', { id: row.id, err }))
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    await Promise.all(
      [...this.live.values()].map(async (live) => {
        live.stoppingAdapter = true
        await live.adapter?.stop().catch(() => undefined)
        live.sandbox?.exec?.close()
      }),
    )
  }
}
