import { z } from 'zod'

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
}

/** Docker-style size: `4g`, `512m`, `1024` (bytes). */
export function parseSize(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(input.trim())
  if (!m) throw new Error(`invalid size: ${input}`)
  const unit = SIZE_UNITS[(m[2] ?? 'b').toLowerCase()]
  if (unit === undefined) throw new Error(`invalid size: ${input}`)
  return Math.round(Number(m[1]) * unit)
}

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v)

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  VALET_SECRET_KEY: z
    .string()
    .min(1)
    .transform((s, ctx) => {
      const key = Buffer.from(s, 'base64')
      if (key.length !== 32) {
        ctx.addIssue({ code: 'custom', message: 'must be 32 random bytes, base64 (openssl rand -base64 32)' })
        return z.NEVER
      }
      return key
    }),
  VALET_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
  VALET_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().default('http://localhost:3000')),
  /** Portal hosts are `t-<thread>-p<port>.<this>`; defaults to the host[:port] of VALET_BASE_URL. */
  VALET_PORTAL_DOMAIN: z.preprocess(emptyToUndefined, z.string().optional()),
  VALET_SANDBOX_IMAGE: z.preprocess(emptyToUndefined, z.string().default('valet-sandbox:latest')),
  /** Discovered from core's own container when unset (the compose project name is not knowable here). */
  VALET_DOCKER_NETWORK: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Named volume, or an absolute host path to bind-mount instead (development). Discovered when unset. */
  VALET_REPOS_VOLUME: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Where core itself sees the repos volume. */
  VALET_REPOS_DIR: z.preprocess(emptyToUndefined, z.string().default('/valet/repos')),
  VALET_IDLE_PAUSE_MINUTES: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(10)),
  VALET_SANDBOX_MEMORY: z.preprocess(emptyToUndefined, z.string().default('4g')).transform(parseSize),
  VALET_SANDBOX_CPUS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(2)),
  /** Process limit per sandbox; stops a fork bomb from reaching the host's pid table. */
  VALET_SANDBOX_PIDS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(2048)),
  VALET_MAX_RUNNING_SANDBOXES: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(8)),
  /** Clone a project's post-setup home volume and reuse it for new threads. */
  VALET_SNAPSHOTS: z
    .preprocess(emptyToUndefined, z.enum(['0', '1']).default('1'))
    .transform((v) => v === '1'),
  /** Total budget for snapshot volumes; least recently used ones are pruned past it. */
  VALET_SNAPSHOT_MAX_GB: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(20)),
  /** Falls back to /var/run/docker.sock when unset (dockerode honours DOCKER_HOST too). */
  DOCKER_HOST: z.preprocess(emptyToUndefined, z.string().optional()),
  DOCKER_SOCKET: z.preprocess(emptyToUndefined, z.string().default('/var/run/docker.sock')),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '$'}: ${i.message}`)
    throw new Error(`invalid configuration:\n${lines.join('\n')}`)
  }
  return parsed.data
}
