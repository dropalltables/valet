import { eq, isNull } from 'drizzle-orm'
import webpush from 'web-push'
import { z } from 'zod'
import { DEFAULT_MODEL, type Settings } from '@valet/shared'
import type { Config } from './config.js'
import type { Cipher } from './crypto.js'
import type { Db } from './db/index.js'
import { settings } from './db/schema.js'

const ROW_ID = 'default'

/** Application server keypair for Web Push (RFC 8292); the private key never leaves core. */
export type VapidKeys = { publicKey: string; privateKey: string }

/** The stored columns, private key still encrypted. */
type StoredVapid = { vapidPublicKey: string; vapidPrivateKeyEnc: string }

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
  private vapid: Promise<VapidKeys> | null = null

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly cipher: Cipher,
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

  /**
   * The VAPID keypair, generated on first use and kept in the settings row. Two
   * processes generating at once still agree on one pair: `setWhere` makes the
   * second write a no-op, and both read the row back.
   */
  vapidKeys(): Promise<VapidKeys> {
    this.vapid ??= this.loadOrCreateVapid().catch((err: unknown) => {
      this.vapid = null
      throw err
    })
    return this.vapid
  }

  /**
   * The public half alone, which browsers subscribe with. It is read without
   * decrypting the private key so a rotated VALET_SECRET_KEY cannot take the
   * notification settings down.
   */
  async vapidPublicKey(): Promise<string> {
    const row = (await this.readVapid()) ?? (await this.generateVapid())
    return row.vapidPublicKey
  }

  private async loadOrCreateVapid(): Promise<VapidKeys> {
    const row = (await this.readVapid()) ?? (await this.generateVapid())
    return { publicKey: row.vapidPublicKey, privateKey: this.cipher.decrypt(row.vapidPrivateKeyEnc) }
  }

  private async generateVapid(): Promise<StoredVapid> {
    const generated = webpush.generateVAPIDKeys()
    await this.db
      .insert(settings)
      .values({
        id: ROW_ID,
        data: {},
        vapidPublicKey: generated.publicKey,
        vapidPrivateKeyEnc: this.cipher.encrypt(generated.privateKey),
      })
      .onConflictDoUpdate({
        target: settings.id,
        set: { vapidPublicKey: generated.publicKey, vapidPrivateKeyEnc: this.cipher.encrypt(generated.privateKey) },
        setWhere: isNull(settings.vapidPublicKey),
      })
    const written = await this.readVapid()
    if (!written) throw new Error('vapid keys are missing after generating them')
    return written
  }

  private async readVapid(): Promise<StoredVapid | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.id, ROW_ID))
    if (!row?.vapidPublicKey || !row.vapidPrivateKeyEnc) return null
    return { vapidPublicKey: row.vapidPublicKey, vapidPrivateKeyEnc: row.vapidPrivateKeyEnc }
  }
}
