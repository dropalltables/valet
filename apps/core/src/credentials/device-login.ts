import { eq } from 'drizzle-orm'
import type { DeviceLogin } from '@valet/shared'
import { SANDBOX } from '@valet/shared'
import { randomHex } from '../crypto.js'
import type { Db } from '../db/index.js'
import { deviceLogins, type DeviceLoginRow } from '../db/schema.js'
import type { DockerClient } from '../docker/client.js'
import { waitForSupervisor } from '../docker/supervisor-client.js'
import { HttpError } from '../errors.js'
import { newId } from '../ids.js'
import { errorMessage, logger } from '../logger.js'
import { emailFromIdToken, type CodexAuthJson, type CredentialStore } from './store.js'

const log = logger('device-login')

const CODEX_HOME = `${SANDBOX.home}/.codex-device-login`
const PARSE_TIMEOUT_MS = 90_000
const LOGIN_TIMEOUT_MS = 15 * 60_000

const URL_RE = /https?:\/\/[^\s"'<>]+/
const CODE_RE = /\b([A-Z0-9]{4,}(?:-[A-Z0-9]{3,})+)\b/
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** The CLI colors the URL and code; strip escapes before matching. */
export function parseDeviceLoginOutput(raw: string): { url: string; code: string } | null {
  const text = raw.replace(ANSI_RE, '')
  const url = URL_RE.exec(text)?.[0]
  const code = CODE_RE.exec(text)?.[1]
  if (!url || !code) return null
  return { url: url.replace(/[.,)]+$/, ''), code }
}

function toApi(row: DeviceLoginRow): DeviceLogin {
  return { id: row.id, status: row.status, verificationUrl: row.verificationUrl, userCode: row.userCode, error: row.error }
}

/**
 * Runs `codex login --device-auth` in a throwaway container built from the sandbox
 * image, with a temporary CODEX_HOME, and stores the resulting auth.json.
 */
export class DeviceLoginManager {
  constructor(
    private readonly db: Db,
    private readonly docker: DockerClient,
    private readonly store: CredentialStore,
    /** Runs after a completed login stored its credential. */
    private readonly onStored: () => void,
  ) {}

  /** Helper containers only live as long as the core process that started them. */
  async reconcile(): Promise<void> {
    for (const c of await this.docker.listHelpers()) {
      log.info('removing orphaned login helper', { id: c.Id, names: c.Names })
      await this.docker.remove(c.Id).catch((err) => log.warn('helper cleanup failed', { id: c.Id, err }))
    }
    await this.db
      .update(deviceLogins)
      .set({ status: 'failed', error: 'Core restarted', updatedAt: new Date() })
      .where(eq(deviceLogins.status, 'pending'))
  }

  async get(id: string): Promise<DeviceLogin | null> {
    const [row] = await this.db.select().from(deviceLogins).where(eq(deviceLogins.id, id))
    return row ? toApi(row) : null
  }

  private async update(id: string, patch: Partial<DeviceLoginRow>): Promise<void> {
    await this.db.update(deviceLogins).set({ ...patch, updatedAt: new Date() }).where(eq(deviceLogins.id, id))
  }

  async start(): Promise<DeviceLogin> {
    const id = newId()
    const token = randomHex(32)
    const name = `valet-login-${id}`
    let containerId: string | null = null
    const cleanup = async (): Promise<void> => {
      if (containerId) await this.docker.remove(containerId).catch((err) => log.warn('helper cleanup failed', { err }))
    }

    try {
      containerId = await this.docker.createHelper(name, token)
      await this.docker.start(containerId)
      const state = await this.docker.inspect(containerId)
      if (!state) throw new Error('helper container vanished')
      const supervisor = await waitForSupervisor(this.docker.supervisorCandidates(name, state), token, 60_000)
      await supervisor.fsMkdir(CODEX_HOME)
      const exec = await supervisor.openExec()
      const proc = await exec.spawn({
        argv: ['codex', 'login', '--device-auth'],
        cwd: SANDBOX.home,
        env: { HOME: SANDBOX.home, CODEX_HOME },
      })

      let output = ''
      let parsed: { url: string; code: string } | null = null
      let resolveParsed!: (v: { url: string; code: string }) => void
      const parsedPromise = new Promise<{ url: string; code: string }>((r) => {
        resolveParsed = r
      })
      const onText = (text: string): void => {
        output = (output + text).slice(-16_384)
        if (!parsed) {
          parsed = parseDeviceLoginOutput(output)
          if (parsed) resolveParsed(parsed)
        }
      }
      proc.onStdoutLine((line) => onText(`${line}\n`))
      proc.onStderr(onText)

      const first = await Promise.race([
        parsedPromise.then((p) => ({ kind: 'parsed' as const, ...p })),
        proc.exited.then((info) => ({ kind: 'exited' as const, ...info })),
        new Promise<{ kind: 'timeout' }>((r) => setTimeout(() => r({ kind: 'timeout' }), PARSE_TIMEOUT_MS)),
      ])
      if (first.kind !== 'parsed') {
        const tail = output.trim().split('\n').slice(-5).join(' ')
        throw new HttpError(
          502,
          first.kind === 'exited'
            ? `codex login exited with code ${first.code ?? 'null'} before printing a code${tail ? `: ${tail}` : ''}`
            : 'codex login did not print a device code in time',
        )
      }

      const [row] = await this.db
        .insert(deviceLogins)
        .values({ id, status: 'pending', verificationUrl: first.url, userCode: first.code, containerId })
        .returning()
      if (!row) throw new Error('failed to record device login')

      const finish = async (): Promise<void> => {
        const outcome = await Promise.race([
          proc.exited.then((info) => ({ kind: 'exited' as const, ...info })),
          new Promise<{ kind: 'timeout' }>((r) => setTimeout(() => r({ kind: 'timeout' }), LOGIN_TIMEOUT_MS)),
        ])
        if (outcome.kind === 'timeout') {
          await proc.signal('SIGTERM').catch(() => undefined)
          await this.update(id, { status: 'expired', error: 'The code expired before the login completed' })
          return
        }
        if (outcome.code !== 0) {
          const tail = output.trim().split('\n').slice(-3).join(' ')
          await this.update(id, { status: 'failed', error: `codex login exited with code ${outcome.code ?? 'null'}${tail ? `: ${tail}` : ''}` })
          return
        }
        const raw = await supervisor.fsRead(`${CODEX_HOME}/auth.json`)
        if (!raw) {
          await this.update(id, { status: 'failed', error: 'codex login finished but wrote no auth.json' })
          return
        }
        const authJson = JSON.parse(raw.toString('utf8')) as CodexAuthJson
        const email = emailFromIdToken(authJson.tokens?.id_token)
        await this.store.put('codex', { authJson }, email ? `ChatGPT (${email})` : 'ChatGPT', 'oauth')
        await this.update(id, { status: 'complete' })
        this.onStored()
      }

      void finish()
        .catch(async (err) => {
          log.error('device login failed', { id, err })
          await this.update(id, { status: 'failed', error: errorMessage(err) }).catch(() => undefined)
        })
        .finally(() => {
          exec.close()
          void cleanup()
        })

      return toApi(row)
    } catch (err) {
      await cleanup()
      throw err
    }
  }
}
