import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { DEFAULT_MODEL, type Settings } from '@valet/shared'
import type { Config } from './config.js'
import type { Db } from './db/index.js'
import { settings } from './db/schema.js'

const ROW_ID = 'default'

export const updateSettingsSchema = z
  .object({
    idlePauseMinutes: z.number().int().min(1).max(24 * 60),
    defaultAgent: z.enum(['claude', 'codex']),
    defaultModel: z.object({ claude: z.string().min(1), codex: z.string().min(1) }).partial(),
    defaultPermissions: z.enum(['auto', 'ask']),
    allowProjectMcpJson: z.boolean(),
  })
  .partial()

export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {}

  private defaults(): Settings {
    return {
      idlePauseMinutes: this.cfg.VALET_IDLE_PAUSE_MINUTES,
      defaultAgent: 'claude',
      defaultModel: { ...DEFAULT_MODEL },
      defaultPermissions: 'auto',
      allowProjectMcpJson: false,
    }
  }

  async get(): Promise<Settings> {
    const [row] = await this.db.select().from(settings).where(eq(settings.id, ROW_ID))
    const base = this.defaults()
    const stored = row?.data ?? {}
    return {
      ...base,
      ...stored,
      defaultModel: { ...base.defaultModel, ...(stored.defaultModel ?? {}) },
    }
  }

  async update(patch: z.infer<typeof updateSettingsSchema>): Promise<Settings> {
    const current = await this.get()
    const defaultModel = { ...current.defaultModel }
    for (const [agent, model] of Object.entries(patch.defaultModel ?? {})) {
      if (model !== undefined) defaultModel[agent as keyof typeof defaultModel] = model
    }
    const next: Settings = {
      idlePauseMinutes: patch.idlePauseMinutes ?? current.idlePauseMinutes,
      defaultAgent: patch.defaultAgent ?? current.defaultAgent,
      defaultPermissions: patch.defaultPermissions ?? current.defaultPermissions,
      allowProjectMcpJson: patch.allowProjectMcpJson ?? current.allowProjectMcpJson,
      defaultModel,
    }
    await this.db
      .insert(settings)
      .values({ id: ROW_ID, data: next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.id, set: { data: next, updatedAt: new Date() } })
    return next
  }
}
