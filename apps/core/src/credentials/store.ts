import { eq } from 'drizzle-orm'
import type { CredentialKind, CredentialStatus } from '@valet/shared'
import type { Cipher } from '../crypto.js'
import type { Db } from '../db/index.js'
import { credentials } from '../db/schema.js'

export type CodexAuthJson = {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string }
  last_refresh?: string
}

export type CredentialPayload = {
  claude: { token: string }
  codex: { apiKey: string } | { authJson: CodexAuthJson }
  github: { token: string }
}

export type StoredCredential<K extends CredentialKind> = {
  kind: K
  payload: CredentialPayload[K]
  label: string | null
  method: 'oauth' | 'api-key' | null
  updatedAt: Date
}

const KINDS: CredentialKind[] = ['claude', 'codex', 'github']

/** `sk-ant-oat01-abc...9f2a` -> `sk-ant-oat…9f2a`; `ghp_abc...a1b2` -> `ghp_…a1b2`. */
export function maskToken(token: string): string {
  const github = /^(?:gh[pousr]|github_pat)_/.exec(token)?.[0]
  const prefix = github ?? (/^[A-Za-z-]{1,10}/.exec(token)?.[0] ?? '').replace(/-$/, '')
  const tail = token.length > 8 ? token.slice(-4) : ''
  return `${prefix}…${tail}`
}

export class CredentialStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}

  async list(): Promise<CredentialStatus[]> {
    const rows = await this.db.select().from(credentials)
    return KINDS.map((kind) => {
      const row = rows.find((r) => r.kind === kind)
      return {
        kind,
        configured: row !== undefined,
        label: row?.label ?? null,
        method: kind === 'github' ? null : (row?.method ?? null),
        updatedAt: row?.updatedAt.toISOString() ?? null,
      }
    })
  }

  async status(kind: CredentialKind): Promise<CredentialStatus> {
    const all = await this.list()
    return all.find((s) => s.kind === kind) as CredentialStatus
  }

  async get<K extends CredentialKind>(kind: K): Promise<StoredCredential<K> | null> {
    const [row] = await this.db.select().from(credentials).where(eq(credentials.kind, kind))
    if (!row) return null
    return {
      kind,
      payload: this.cipher.decryptJson<CredentialPayload[K]>(row.payloadEnc),
      label: row.label,
      method: row.method,
      updatedAt: row.updatedAt,
    }
  }

  async put<K extends CredentialKind>(
    kind: K,
    payload: CredentialPayload[K],
    label: string | null,
    method: 'oauth' | 'api-key' | null,
  ): Promise<CredentialStatus> {
    const payloadEnc = this.cipher.encryptJson(payload)
    const now = new Date()
    await this.db
      .insert(credentials)
      .values({ kind, payloadEnc, label, method, updatedAt: now })
      .onConflictDoUpdate({ target: credentials.kind, set: { payloadEnc, label, method, updatedAt: now } })
    return this.status(kind)
  }

  async remove(kind: CredentialKind): Promise<void> {
    await this.db.delete(credentials).where(eq(credentials.kind, kind))
  }

  /** Env for the Claude Code CLI, keyed by token type. */
  async claudeEnv(): Promise<Record<string, string> | null> {
    const cred = await this.get('claude')
    if (!cred) return null
    const token = cred.payload.token
    return token.startsWith('sk-ant-oat') ? { CLAUDE_CODE_OAUTH_TOKEN: token } : { ANTHROPIC_API_KEY: token }
  }

  async codexAuth(): Promise<{ mode: 'api-key'; apiKey: string } | { mode: 'oauth'; authJson: CodexAuthJson; label: string | null } | null> {
    const cred = await this.get('codex')
    if (!cred) return null
    if ('apiKey' in cred.payload) return { mode: 'api-key', apiKey: cred.payload.apiKey }
    return { mode: 'oauth', authJson: cred.payload.authJson, label: cred.label }
  }

  async githubToken(): Promise<string | null> {
    const cred = await this.get('github')
    return cred?.payload.token ?? null
  }
}

/** Email claim from a Codex `id_token`, when present. */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  const parts = idToken.split('.')
  if (parts.length < 2 || !parts[1]) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { email?: unknown }
    return typeof payload.email === 'string' ? payload.email : null
  } catch {
    return null
  }
}
