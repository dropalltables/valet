import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm'
import type { SnapshotsResponse } from '@valet/shared'
import type { Config } from '../config.js'
import { randomHex } from '../crypto.js'
import type { Db } from '../db/index.js'
import { projects, type ProjectRow, type ThreadRow } from '../db/schema.js'
import { LABEL_KEY, LABEL_PROJECT, LABEL_SNAPSHOT, LABEL_THREAD, snapshotVolumeName, type DockerClient } from '../docker/client.js'
import type { EventLog } from '../events/log.js'
import { logger } from '../logger.js'
import { shortSnapshotKey } from '../threads/sandbox-ops.js'
import { toProject } from './mapper.js'

const log = logger('snapshots')

const SWEEP_INTERVAL_MS = 60 * 60_000
/** A snapshot no thread has started from in a week is worth less than the disk it holds. */
export const UNUSED_TTL_MS = 7 * 24 * 60 * 60_000
/** A capture is between its copy and its row update for at most this long. */
const ORPHAN_GRACE_MS = 15 * 60_000

/**
 * One warm-start volume per project, cloned from a thread's home volume once
 * `.valet/setup` succeeded there. Threads whose key matches restore it instead of
 * cloning the repository and running setup again.
 */
export class SnapshotStore {
  private sweeper: NodeJS.Timeout | null = null

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly docker: DockerClient,
    private readonly events: EventLog,
  ) {}

  get enabled(): boolean {
    return this.cfg.VALET_SNAPSHOTS
  }

  private get budgetBytes(): number {
    return Math.round(this.cfg.VALET_SNAPSHOT_MAX_GB * 1024 ** 3)
  }

  private async patch(id: string, set: Partial<ProjectRow>): Promise<void> {
    const [row] = await this.db.update(projects).set({ ...set, updatedAt: new Date() }).where(eq(projects.id, id)).returning()
    if (row) this.events.publishProject(toProject(row))
  }

  private static readonly CLEARED: Partial<ProjectRow> = {
    snapshotKey: null,
    snapshotBaseBranch: null,
    snapshotVolume: null,
    snapshotSizeBytes: null,
    snapshotCreatedAt: null,
    snapshotLastUsedAt: null,
  }

  async usage(): Promise<SnapshotsResponse> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${projects.snapshotSizeBytes}), 0)::bigint` })
      .from(projects)
      .where(isNotNull(projects.snapshotVolume))
    return {
      enabled: this.enabled,
      count: row?.count ?? 0,
      totalBytes: Number(row?.bytes ?? 0),
      budgetBytes: this.budgetBytes,
    }
  }

  /** Removes a project's snapshot volume and clears its row; the next thread rebuilds it. */
  async drop(projectId: string, why: string): Promise<void> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, projectId))
    if (!row?.snapshotVolume) return
    log.info('dropping snapshot', { projectId, why, volume: row.snapshotVolume, bytes: row.snapshotSizeBytes })
    await this.docker.removeVolume(row.snapshotVolume)
    await this.patch(projectId, SnapshotStore.CLEARED)
  }

  /**
   * The key of the snapshot the thread's home volume holds: clones the project's snapshot
   * there when the volume does not exist yet, and otherwise reports the key an earlier
   * provisioning attempt already put there. Null means an empty or self-cloned volume.
   *
   * The key is a label on the thread volume, written before the copy starts, so an attempt
   * that dies anywhere between here and the branch being cut cannot leave a restored
   * checkout that the next one mistakes for a fresh clone. The caller verifies the key
   * against the repository at base head before trusting that checkout either way.
   */
  async restore(project: ProjectRow, thread: ThreadRow, signal?: AbortSignal): Promise<string | null> {
    const existing = await this.docker.volumeLabels(thread.volumeName)
    if (existing) return existing[LABEL_KEY] ?? null
    if (!this.enabled || !project.snapshotVolume || !project.snapshotKey) return null
    // The base branch is part of the key, but comparing it here avoids copying gigabytes
    // only to find out; a thread on another branch leaves the snapshot alone.
    if (project.snapshotBaseBranch !== thread.baseBranch) return null
    if (!(await this.docker.volumeExists(project.snapshotVolume))) {
      await this.patch(project.id, SnapshotStore.CLEARED)
      return null
    }
    const key = project.snapshotKey
    const labels = { [LABEL_THREAD]: thread.id, [LABEL_PROJECT]: project.id, [LABEL_KEY]: key }
    try {
      await this.docker.cloneVolume(project.snapshotVolume, thread.volumeName, labels, signal)
    } catch (err) {
      if (signal?.aborted) throw err
      log.warn('restoring snapshot failed', { projectId: project.id, err })
      return null
    }
    await this.patch(project.id, { snapshotLastUsedAt: new Date() })
    return key
  }

  /**
   * Replaces the project's snapshot with a clone of `sourceVolume`. The clone goes to a
   * name of its own and the previous volume is only removed once the new one is complete
   * and recorded, so nothing ever overwrites the volume the project currently points at
   * and a failure leaves the previous snapshot in place. Never throws: a thread is
   * usable without a snapshot.
   */
  async capture(projectId: string, key: string, baseBranch: string, sourceVolume: string, signal?: AbortSignal): Promise<void> {
    if (!this.enabled) return
    // Read here rather than taken from the caller: its row predates the setup this
    // captures, and another thread on the same project may have recorded one since.
    const [current] = await this.db.select().from(projects).where(eq(projects.id, projectId))
    if (!current) return
    if (current.snapshotKey === key && current.snapshotVolume && (await this.docker.volumeExists(current.snapshotVolume))) return
    const previous = current.snapshotVolume
    const target = snapshotVolumeName(projectId, `${shortSnapshotKey(key)}-${randomHex(4)}`)
    try {
      const sizeBytes = await this.docker.cloneVolume(
        sourceVolume,
        target,
        { [LABEL_SNAPSHOT]: 'true', [LABEL_PROJECT]: projectId, [LABEL_KEY]: key },
        signal,
      )
      const now = new Date()
      await this.patch(projectId, {
        snapshotKey: key,
        snapshotBaseBranch: baseBranch,
        snapshotVolume: target,
        snapshotSizeBytes: sizeBytes,
        snapshotCreatedAt: now,
        snapshotLastUsedAt: now,
      })
      log.info('captured snapshot', { projectId, key: shortSnapshotKey(key), bytes: sizeBytes })
    } catch (err) {
      log.warn('capturing snapshot failed', { projectId, err })
      return
    }
    // Outside the try: a volume Docker will not remove yet (a restore has it mounted)
    // must not report a capture that succeeded as failed. The sweep collects it later.
    if (previous && previous !== target) {
      await this.docker.removeVolume(previous).catch((err: unknown) => log.warn('removing the previous snapshot failed', { projectId, volume: previous, err }))
    }
    await this.prune().catch((err: unknown) => log.warn('prune after capture failed', { err }))
  }

  /** Prunes now and hourly after that; a core restarted often would otherwise never prune. */
  startSweeper(): void {
    if (this.sweeper) return
    const sweep = (): void => void this.prune().catch((err: unknown) => log.error('snapshot sweep failed', { err }))
    this.sweeper = setInterval(sweep, SWEEP_INTERVAL_MS)
    this.sweeper.unref()
    sweep()
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
  }

  /**
   * Drops snapshots unused for a week, then the least recently used ones until under
   * budget. A volume Docker refuses to remove (a copy has it mounted right now) must not
   * cancel the rest of the sweep, so every drop reports rather than throws.
   */
  async prune(): Promise<void> {
    const stale = await this.db
      .select()
      .from(projects)
      .where(and(isNotNull(projects.snapshotVolume), lt(projects.snapshotLastUsedAt, new Date(Date.now() - UNUSED_TTL_MS))))
    for (const row of stale) await this.tryDrop(row.id, 'unused for 7 days')

    const rows = await this.db
      .select()
      .from(projects)
      .where(isNotNull(projects.snapshotVolume))
      .orderBy(asc(projects.snapshotLastUsedAt))
    let total = rows.reduce((sum, row) => sum + (row.snapshotSizeBytes ?? 0), 0)
    for (const row of rows) {
      if (total <= this.budgetBytes) break
      if (await this.tryDrop(row.id, `over the ${this.cfg.VALET_SNAPSHOT_MAX_GB} GB budget`)) total -= row.snapshotSizeBytes ?? 0
    }
    await this.removeOrphans()
  }

  private async tryDrop(projectId: string, why: string): Promise<boolean> {
    try {
      await this.drop(projectId, why)
      return true
    } catch (err) {
      log.warn('snapshot drop failed', { projectId, why, err })
      return false
    }
  }

  /**
   * Snapshot volumes of a known project that it no longer points at, left behind by a
   * crash between the clone and the row update. Volumes labelled with an unknown project
   * belong to another Valet on the same Docker host and are left alone, and so is a
   * volume young enough to be a capture that has copied but not yet recorded itself,
   * including one whose age Docker does not report.
   */
  private async removeOrphans(): Promise<void> {
    const volumes = await this.docker.listSnapshotVolumes()
    if (volumes.length === 0) return
    const rows = await this.db.select({ id: projects.id, volume: projects.snapshotVolume }).from(projects)
    const current = new Map(rows.map((r) => [r.id, r.volume]))
    const oldEnough = Date.now() - ORPHAN_GRACE_MS
    for (const volume of volumes) {
      const projectId = volume.Labels?.[LABEL_PROJECT]
      if (projectId === undefined || !current.has(projectId)) continue
      if (current.get(projectId) === volume.Name) continue
      const createdAt = Date.parse(volume.CreatedAt ?? '')
      if (!Number.isFinite(createdAt) || createdAt > oldEnough) continue
      log.info('removing orphaned snapshot volume', { projectId, volume: volume.Name })
      await this.docker.removeVolume(volume.Name).catch((err: unknown) => log.warn('orphan removal failed', { volume: volume.Name, err }))
    }
  }
}
