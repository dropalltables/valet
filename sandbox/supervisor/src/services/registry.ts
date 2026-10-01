import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { SANDBOX, serviceBrowserSchema } from '@valet/shared'

/**
 * One registered service. The registry file on the home volume is the source of
 * truth: supervisord units are regenerated from it on every container start.
 */
export const registryEntrySchema = z.object({
  name: z.string(),
  command: z.string(),
  cwd: z.string(),
  /** The service's own variables; PORT, PUBLIC_URL, VALET_* are added at unit generation. */
  env: z.record(z.string(), z.string()),
  port: z.number().nullable(),
  browser: serviceBrowserSchema,
  health: z.string().nullable(),
  /** Defaulted so a registry written before the review widget existed still loads. */
  review: z.boolean().default(true),
  source: z.enum(['adhoc', 'yaml']),
  /** Hash of the declared spec for `yaml` services; `ensure` restarts the unit when it changes. */
  specHash: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RegistryEntry = z.infer<typeof registryEntrySchema>

const fileSchema = z.array(registryEntrySchema)

export class Registry {
  private entries = new Map<string, RegistryEntry>()

  constructor(private readonly file = SANDBOX.servicesFile) {}

  /**
   * A file that does not parse is set aside (renamed) rather than obeyed or
   * silently replaced: the error is logged and the sandbox keeps working.
   */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch (err) {
      await this.setAside((err as Error).message)
      return
    }
    const parsed = fileSchema.safeParse(data)
    if (!parsed.success) {
      await this.setAside(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      return
    }
    this.entries = new Map(parsed.data.map((e) => [e.name, e]))
  }

  private async setAside(problem: string): Promise<void> {
    const aside = `${this.file}.corrupt-${Date.now()}`
    console.error(`${this.file}: ${problem}; moved to ${aside}`)
    await rename(this.file, aside)
  }

  all(): RegistryEntry[] {
    return [...this.entries.values()]
  }

  get(name: string): RegistryEntry | undefined {
    return this.entries.get(name)
  }

  async put(entry: RegistryEntry): Promise<void> {
    this.entries.set(entry.name, entry)
    await this.save()
  }

  async remove(name: string): Promise<boolean> {
    const had = this.entries.delete(name)
    if (had) await this.save()
    return had
  }

  /** Ports held by registered services, by port. */
  portOwners(): Map<number, string> {
    const owners = new Map<number, string>()
    for (const e of this.entries.values()) if (e.port !== null) owners.set(e.port, e.name)
    return owners
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.all(), null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, this.file)
  }
}
