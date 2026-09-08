import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { asc, count, eq } from 'drizzle-orm'
import type { Project, ProjectEnvVar } from '@valet/shared'
import type { Config } from '../config.js'
import { maskSecret, type Cipher } from '../crypto.js'
import type { Db } from '../db/index.js'
import { projectEnvVars, projects, threads, type ProjectRow } from '../db/schema.js'
import { badRequest, conflict, notFound } from '../errors.js'
import type { EventLog } from '../events/log.js'
import { canonicalRepoUrl, parseGitHubUrl } from '../git/github.js'
import { newId } from '../ids.js'
import { logger } from '../logger.js'
import { toProject } from './mapper.js'
import type { SnapshotStore } from './snapshots.js'

const log = logger('projects')
const exec = promisify(execFile)

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Request shapes as the routes validate them (optional fields may be explicitly undefined).
export type CreateProjectInput =
  | { source: 'github'; repoUrl: string; defaultBranch?: string | undefined; name?: string | undefined }
  | { source: 'blank'; name: string }
export type UpdateProjectInput = { name?: string | undefined; defaultBranch?: string | undefined }
export type PutProjectEnvInput = { vars: Array<{ name: string; value?: string | undefined; kind: 'plain' | 'secret' }> }

function maskValue(value: string): string {
  if (value.length <= 4) return '****'
  return `${value.slice(0, 2)}…${value.slice(-2)}`
}

export class ProjectService {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
    private readonly cfg: Config,
    private readonly events: EventLog,
    private readonly snapshots: SnapshotStore,
    private readonly lookupDefaultBranch: (repoUrl: string) => Promise<string | null>,
  ) {}

  bareRepoPath(projectId: string): string {
    return path.join(this.cfg.VALET_REPOS_DIR, `${projectId}.git`)
  }

  async list(): Promise<Project[]> {
    const rows = await this.db.select().from(projects).orderBy(asc(projects.name))
    return rows.map(toProject)
  }

  async getRow(id: string): Promise<ProjectRow> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, id))
    if (!row) throw notFound('project')
    return row
  }

  async get(id: string): Promise<Project> {
    return toProject(await this.getRow(id))
  }

  async create(req: CreateProjectInput): Promise<Project> {
    const id = newId()
    let row: ProjectRow | undefined
    if (req.source === 'github') {
      const ref = parseGitHubUrl(req.repoUrl)
      if (!ref) throw badRequest('repoUrl must be a GitHub repository URL')
      const defaultBranch = req.defaultBranch?.trim() || (await this.lookupDefaultBranch(canonicalRepoUrl(ref))) || 'main'
      ;[row] = await this.db
        .insert(projects)
        .values({
          id,
          name: req.name?.trim() || ref.repo,
          source: 'github',
          repoUrl: canonicalRepoUrl(ref),
          defaultBranch,
          hasSetupScript: null,
        })
        .returning()
    } else {
      const name = req.name.trim()
      if (!name) throw badRequest('name is required')
      await this.initBareRepo(id)
      ;[row] = await this.db
        .insert(projects)
        .values({ id, name, source: 'blank', repoUrl: null, defaultBranch: 'main', hasSetupScript: false })
        .returning()
    }
    if (!row) throw new Error('insert returned no row')
    const project = toProject(row)
    this.events.publishProject(project)
    return project
  }

  /** Bare repo with one empty commit on `main`, so clones and merge-bases work from the start. */
  private async initBareRepo(projectId: string): Promise<void> {
    const bare = this.bareRepoPath(projectId)
    await fs.mkdir(this.cfg.VALET_REPOS_DIR, { recursive: true })
    await exec('git', ['init', '--bare', '--initial-branch=main', bare])
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'valet-init-'))
    try {
      const env = { ...process.env, GIT_AUTHOR_NAME: 'Valet', GIT_AUTHOR_EMAIL: 'valet@localhost', GIT_COMMITTER_NAME: 'Valet', GIT_COMMITTER_EMAIL: 'valet@localhost' }
      await exec('git', ['init', '--initial-branch=main', tmp], { env })
      await exec('git', ['-C', tmp, 'commit', '--allow-empty', '-m', 'Initial commit'], { env })
      await exec('git', ['-C', tmp, 'push', bare, 'main'], { env })
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
    // Sandboxes run as uid 1000 and need to push back into the bare repo.
    await exec('chmod', ['-R', 'a+rwX', bare]).catch((err) => log.warn('chmod on bare repo failed', { err }))
  }

  async update(id: string, patch: UpdateProjectInput): Promise<Project> {
    await this.getRow(id)
    const set: Partial<ProjectRow> = { updatedAt: new Date() }
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw badRequest('name must not be empty')
      set.name = patch.name.trim()
    }
    if (patch.defaultBranch !== undefined) {
      if (!patch.defaultBranch.trim()) throw badRequest('defaultBranch must not be empty')
      set.defaultBranch = patch.defaultBranch.trim()
    }
    const [row] = await this.db.update(projects).set(set).where(eq(projects.id, id)).returning()
    if (!row) throw notFound('project')
    const project = toProject(row)
    this.events.publishProject(project)
    return project
  }

  async setHasSetupScript(id: string, value: boolean): Promise<void> {
    const [row] = await this.db.update(projects).set({ hasSetupScript: value, updatedAt: new Date() }).where(eq(projects.id, id)).returning()
    if (row) this.events.publishProject(toProject(row))
  }

  async threadCount(id: string): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(threads).where(eq(threads.projectId, id))
    return row?.n ?? 0
  }

  /** Callers delete the project's threads first; this refuses while any remain. */
  async remove(id: string): Promise<void> {
    const row = await this.getRow(id)
    if ((await this.threadCount(id)) > 0) throw conflict('project still has threads')
    await this.snapshots.drop(id, 'project deleted').catch((err: unknown) => log.warn('failed to remove snapshot', { id, err }))
    await this.db.delete(projects).where(eq(projects.id, id))
    if (row.source === 'blank') {
      await fs.rm(this.bareRepoPath(id), { recursive: true, force: true }).catch((err) => log.warn('failed to remove bare repo', { id, err }))
    }
    this.events.publishProjectDeleted(id)
  }

  async listEnv(id: string): Promise<ProjectEnvVar[]> {
    await this.getRow(id)
    const rows = await this.db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, id)).orderBy(asc(projectEnvVars.name))
    return rows.map((r) => ({ name: r.name, maskedValue: maskSecret(this.cipher.decrypt(r.valueEnc)), kind: r.kind }))
  }

  async putEnv(id: string, req: PutProjectEnvInput): Promise<ProjectEnvVar[]> {
    await this.getRow(id)
    const seen = new Set<string>()
    for (const v of req.vars) {
      if (!ENV_NAME_RE.test(v.name)) throw badRequest(`invalid variable name: ${v.name}`)
      if (seen.has(v.name)) throw badRequest(`duplicate variable: ${v.name}`)
      seen.add(v.name)
    }
    const existing = await this.db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, id))
    const existingByName = new Map(existing.map((r) => [r.name, r]))
    await this.db.transaction(async (tx) => {
      await tx.delete(projectEnvVars).where(eq(projectEnvVars.projectId, id))
      for (const v of req.vars) {
        const valueEnc = v.value !== undefined ? this.cipher.encrypt(v.value) : existingByName.get(v.name)?.valueEnc
        if (valueEnc === undefined) throw badRequest(`value is required for new variable ${v.name}`)
        await tx.insert(projectEnvVars).values({ projectId: id, name: v.name, valueEnc, kind: v.kind })
      }
    })
    return this.listEnv(id)
  }

  async decryptedEnv(id: string): Promise<Record<string, string>> {
    const rows = await this.db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, id))
    const env: Record<string, string> = {}
    for (const r of rows) env[r.name] = this.cipher.decrypt(r.valueEnc)
    return env
  }
}
