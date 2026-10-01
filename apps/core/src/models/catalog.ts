import { eq } from 'drizzle-orm'
import { DEFAULT_MODELS, SANDBOX, type AgentKind, type ModelOption, type ModelsSource } from '@valet/shared'
import { listClaudeModels, listCodexModels, MODEL_LIST_TIMEOUT_MS } from '../agents/model-list.js'
import type { CredentialStore } from '../credentials/store.js'
import { randomHex } from '../crypto.js'
import type { Db } from '../db/index.js'
import { modelCatalog, type ModelCatalogRow } from '../db/schema.js'
import type { DockerClient } from '../docker/client.js'
import { waitForSupervisor } from '../docker/supervisor-client.js'
import { newId } from '../ids.js'
import { errorMessage, logger } from '../logger.js'
import { syncCodexAuth, writeCodexHome } from '../threads/sandbox-ops.js'

const log = logger('models')

const AGENTS: AgentKind[] = ['claude', 'codex']
/** Helper boot and the CLI's answer together; the process teardown after it is not counted. */
const REFRESH_MS = MODEL_LIST_TIMEOUT_MS
/** Startup refreshes a catalog older than this. */
export const STALE_AFTER_MS = 24 * 60 * 60_000

export type CatalogEntry = {
  models: ModelOption[]
  source: ModelsSource
  refreshedAt: Date | null
  error: string | null
}

const DEFAULT_ENTRY = (agent: AgentKind): CatalogEntry => ({
  models: [...DEFAULT_MODELS[agent]],
  source: 'default',
  refreshedAt: null,
  error: null,
})

function toEntry(agent: AgentKind, row: ModelCatalogRow | undefined): CatalogEntry {
  if (!row) return DEFAULT_ENTRY(agent)
  return {
    models: row.source === 'default' ? [...DEFAULT_MODELS[agent]] : row.models,
    source: row.source,
    refreshedAt: row.refreshedAt,
    error: row.error,
  }
}

type Inflight = { current: Promise<CatalogEntry>; next: Promise<CatalogEntry> | null }

/**
 * Model lists per agent, read from the CLIs and kept in `model_catalog`. A refresh
 * runs the CLI in a throwaway container from the sandbox image with the stored
 * credential, exactly as a thread would; failures keep the previous list and
 * record the error. Without a credential there is nothing to ask, so the entry
 * falls back to the static defaults.
 */
export class ModelCatalog {
  private readonly inflight = new Map<AgentKind, Inflight>()

  constructor(
    private readonly db: Db,
    private readonly docker: DockerClient,
    private readonly credentials: CredentialStore,
  ) {}

  async all(): Promise<Record<AgentKind, CatalogEntry>> {
    const rows = await this.db.select().from(modelCatalog)
    return {
      claude: toEntry('claude', rows.find((r) => r.agent === 'claude')),
      codex: toEntry('codex', rows.find((r) => r.agent === 'codex')),
    }
  }

  /**
   * One refresh per agent at a time. A request while one runs gets a single follow-up
   * run afterwards, since the running one read the credential before the request.
   * Never rejects: failures land in the entry's `error`.
   */
  refresh(agent: AgentKind): Promise<CatalogEntry> {
    const running = this.inflight.get(agent)
    if (!running) return this.start(agent)
    running.next ??= running.current.then(() => this.start(agent))
    return running.next
  }

  private start(agent: AgentKind): Promise<CatalogEntry> {
    const current = this.run(agent).finally(() => this.inflight.delete(agent))
    this.inflight.set(agent, { current, next: null })
    return current
  }

  /** Back to the defaults; for when the credential is removed. */
  async clear(agent: AgentKind): Promise<void> {
    await this.db.delete(modelCatalog).where(eq(modelCatalog.agent, agent))
  }

  /** Refreshes, in the background, every configured agent whose list is missing or older than `maxAgeMs`. */
  async refreshStale(maxAgeMs: number): Promise<void> {
    const entries = await this.all()
    for (const agent of AGENTS) {
      if (!(await this.credentials.hasAccounts(agent))) continue
      const at = entries[agent].refreshedAt
      if (at && Date.now() - at.getTime() < maxAgeMs) continue
      void this.refresh(agent)
    }
  }

  private async run(agent: AgentKind): Promise<CatalogEntry> {
    const started = Date.now()
    try {
      const models = await this.fetch(agent)
      // The account may have been removed while the CLI ran; its list no longer applies.
      if (models === null || !(await this.credentials.hasAccounts(agent))) {
        await this.clear(agent)
        return DEFAULT_ENTRY(agent)
      }
      if (models.length === 0) throw new Error(`${agent} reported no models`)
      const now = new Date()
      await this.db
        .insert(modelCatalog)
        .values({ agent, models, source: 'cli', refreshedAt: now, error: null })
        .onConflictDoUpdate({ target: modelCatalog.agent, set: { models, source: 'cli', refreshedAt: now, error: null } })
      log.info('model catalog refreshed', { agent, count: models.length, ms: Date.now() - started })
      return { models, source: 'cli', refreshedAt: now, error: null }
    } catch (err) {
      const error = errorMessage(err)
      log.warn('model catalog refresh failed', { agent, error, ms: Date.now() - started })
      if (!(await this.credentials.hasAccounts(agent))) {
        await this.clear(agent)
        return DEFAULT_ENTRY(agent)
      }
      await this.db
        .insert(modelCatalog)
        .values({ agent, models: [], source: 'default', refreshedAt: null, error })
        .onConflictDoUpdate({ target: modelCatalog.agent, set: { error } })
        .catch((dbErr: unknown) => log.error('failed to record model catalog error', { agent, err: dbErr }))
      return (await this.all())[agent]
    }
  }

  /** Asks under the agent's oldest account; null when it has none. */
  private async fetch(agent: AgentKind): Promise<ModelOption[] | null> {
    const account = await this.credentials.firstAccount(agent)
    if (!account) return null
    const claude = agent === 'claude' ? await this.credentials.claudeEnvFor(account.id) : null
    const codex = agent === 'codex' ? await this.credentials.codexAuthFor(account.id) : null
    if (!claude && !codex) return null

    const id = newId()
    const token = randomHex(32)
    const name = `valet-models-${agent}-${id}`
    const deadline = Date.now() + REFRESH_MS
    const remainingMs = (): number => Math.max(1, deadline - Date.now())
    const containerId = await this.docker.createHelper(name, token)
    try {
      await this.docker.start(containerId)
      const state = await this.docker.inspect(containerId)
      if (!state) throw new Error('helper container vanished')
      const supervisor = await waitForSupervisor(this.docker.supervisorCandidates(name, state), token, remainingMs())
      const exec = await supervisor.openExec()
      try {
        if (claude) {
          const env = { HOME: SANDBOX.home, CLAUDE_CONFIG_DIR: SANDBOX.claudeConfigDir, ...claude }
          return await listClaudeModels({ runner: exec, cwd: SANDBOX.home, env, timeoutMs: remainingMs() })
        }
        if (!codex) throw new Error('unreachable')
        const env: Record<string, string> = { HOME: SANDBOX.home, CODEX_HOME: SANDBOX.codexHome }
        if (codex.mode === 'api-key') env.CODEX_API_KEY = codex.apiKey
        await writeCodexHome(supervisor, codex.mode === 'oauth' ? codex.authJson : null, [])
        try {
          return await listCodexModels({ runner: exec, cwd: SANDBOX.home, env, timeoutMs: remainingMs() })
        } finally {
          if (codex.mode === 'oauth') {
            await syncCodexAuth(supervisor, this.credentials, account.id).catch((err: unknown) => log.warn('codex auth sync failed', { name, err }))
          }
        }
      } finally {
        exec.close()
      }
    } finally {
      await this.docker.remove(containerId).catch((err: unknown) => log.warn('helper cleanup failed', { name, err }))
    }
  }
}
