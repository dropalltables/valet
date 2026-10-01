import { asc, eq } from 'drizzle-orm'
import { AGENT_LABELS, type AgentAccount, type AgentKind, type CredentialKind, type CredentialStatus } from '@valet/shared'
import type { Cipher } from '../crypto.js'
import type { Db } from '../db/index.js'
import { accounts, credentials, type AccountRow } from '../db/schema.js'
import { conflict, notFound } from '../errors.js'
import { newId } from '../ids.js'
import { randomAccountName } from './names.js'
import { GitHubApp, type GitHubAppCredentials, type RepoRef } from '../git/github.js'
import { logger } from '../logger.js'

const log = logger('credentials')

/** Installation tokens live an hour; re-mint one this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000

export type CodexAuthJson = {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string }
  last_refresh?: string
}

export type GitHubAppPayload = GitHubAppCredentials & { webhookSecret: string }

export type CredentialPayload = {
  github: { token: string }
  'github-app': GitHubAppPayload
}

export type AccountPayload = {
  claude: { token: string }
  codex: { apiKey: string } | { authJson: CodexAuthJson }
}

export type StoredAccount<A extends AgentKind = AgentKind> = AgentAccount & { agent: A; payload: AccountPayload[A] }

export type StoredCredential<K extends CredentialKind> = {
  kind: K
  payload: CredentialPayload[K]
  label: string | null
  method: 'oauth' | 'api-key' | null
  updatedAt: Date
}

const KINDS: CredentialKind[] = ['github', 'github-app']

/** Postgres: unique_violation. */
const UNIQUE_VIOLATION = '23505'

function toAccount(row: Pick<AccountRow, 'id' | 'agent' | 'name' | 'label' | 'method' | 'createdAt' | 'updatedAt'>): AgentAccount {
  return { id: row.id, agent: row.agent, name: row.name, label: row.label, method: row.method, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION
}

/** `sk-ant-oat01-abc...9f2a` -> `sk-ant-oat…9f2a`; `ghp_abc...a1b2` -> `ghp_…a1b2`. */
export function maskToken(token: string): string {
  const github = /^(?:gh[pousr]|github_pat)_/.exec(token)?.[0]
  const prefix = github ?? (/^[A-Za-z-]{1,10}/.exec(token)?.[0] ?? '').replace(/-$/, '')
  const tail = token.length > 8 ? token.slice(-4) : ''
  return `${prefix}…${tail}`
}

export class CredentialStore {
  /** Installation tokens by `owner/repo`, lowercased. */
  private readonly appTokens = new Map<string, { token: string; expiresAt: number }>()

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
        method: null,
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
    if (kind === 'github-app') this.appTokens.clear()
    return this.status(kind)
  }

  async remove(kind: CredentialKind): Promise<void> {
    await this.db.delete(credentials).where(eq(credentials.kind, kind))
    if (kind === 'github-app') this.appTokens.clear()
  }

  // ---- agent accounts -------------------------------------------------------------

  /** Every account, oldest first; `agent` narrows to one agent. */
  async accounts(agent?: AgentKind): Promise<AgentAccount[]> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(agent ? eq(accounts.agent, agent) : undefined)
      .orderBy(asc(accounts.createdAt), asc(accounts.id))
    return rows.map(toAccount)
  }

  async hasAccounts(agent: AgentKind): Promise<boolean> {
    return (await this.accounts(agent)).length > 0
  }

  /** The agent's oldest account: what runs when nothing picked one. */
  async firstAccount(agent: AgentKind): Promise<AgentAccount | null> {
    return (await this.accounts(agent))[0] ?? null
  }

  async account(id: string): Promise<StoredAccount | null> {
    const [row] = await this.db.select().from(accounts).where(eq(accounts.id, id))
    if (!row) return null
    return { ...toAccount(row), payload: this.cipher.decryptJson<AccountPayload[AgentKind]>(row.payloadEnc) }
  }

  /** 409 when the agent already has an account with that name; a null name is generated. */
  async addAccount<A extends AgentKind>(agent: A, name: string | null, payload: AccountPayload[A], label: string | null, method: 'oauth' | 'api-key'): Promise<AgentAccount> {
    const now = new Date()
    const payloadEnc = this.cipher.encryptJson(payload)
    const row = { id: newId(), agent, name: name ?? randomAccountName(), payloadEnc, label, method, createdAt: now, updatedAt: now }
    await this.db.insert(accounts).values(row).catch((err: unknown) => {
      throw isUniqueViolation(err) ? conflict(`${AGENT_LABELS[agent]} already has an account named ${row.name}`) : err
    })
    return toAccount(row)
  }

  async renameAccount(id: string, name: string): Promise<AgentAccount> {
    const [row] = await this.db
      .update(accounts)
      .set({ name, updatedAt: new Date() })
      .where(eq(accounts.id, id))
      .returning()
      .catch((err: unknown) => {
        throw isUniqueViolation(err) ? conflict(`An account named ${name} already exists for this agent`) : err
      })
    if (!row) throw notFound('account')
    return toAccount(row)
  }

  /** Replaces the secret, keeping the name: Codex rewrites its tokens on refresh. */
  async updateAccountPayload<A extends AgentKind>(id: string, payload: AccountPayload[A]): Promise<void> {
    await this.db.update(accounts).set({ payloadEnc: this.cipher.encryptJson(payload), updatedAt: new Date() }).where(eq(accounts.id, id))
  }

  /** Threads that ran under it keep their history; their `accountId` becomes null. */
  async removeAccount(id: string): Promise<AgentAccount> {
    const [row] = await this.db.delete(accounts).where(eq(accounts.id, id)).returning()
    if (!row) throw notFound('account')
    return toAccount(row)
  }

  /** Env for the Claude Code CLI under one account, keyed by token type. */
  async claudeEnvFor(accountId: string): Promise<Record<string, string> | null> {
    const account = await this.account(accountId)
    if (!account || account.agent !== 'claude' || !('token' in account.payload)) return null
    const token = account.payload.token
    return token.startsWith('sk-ant-oat') ? { CLAUDE_CODE_OAUTH_TOKEN: token } : { ANTHROPIC_API_KEY: token }
  }

  async codexAuthFor(accountId: string): Promise<{ mode: 'api-key'; apiKey: string } | { mode: 'oauth'; authJson: CodexAuthJson } | null> {
    const account = await this.account(accountId)
    if (!account || account.agent !== 'codex') return null
    if ('apiKey' in account.payload) return { mode: 'api-key', apiKey: account.payload.apiKey }
    if ('authJson' in account.payload) return { mode: 'oauth', authJson: account.payload.authJson }
    return null
  }

  /** The personal access token; user-scoped calls (listing repositories) need it. */
  async githubToken(): Promise<string | null> {
    const cred = await this.get('github')
    return cred?.payload.token ?? null
  }

  async githubApp(): Promise<GitHubAppPayload | null> {
    const cred = await this.get('github-app')
    return cred?.payload ?? null
  }

  /**
   * The token to use against one repository: the GitHub App's installation token
   * when an App is configured and installed there, else the personal access token.
   */
  async githubTokenFor(ref: RepoRef): Promise<string | null> {
    const app = await this.githubApp()
    const installation = app ? await this.installationToken(app, ref) : null
    return installation ?? (await this.githubToken())
  }

  private async installationToken(app: GitHubAppPayload, ref: RepoRef): Promise<string | null> {
    const key = `${ref.owner}/${ref.repo}`.toLowerCase()
    const cached = this.appTokens.get(key)
    if (cached && cached.expiresAt - Date.now() > TOKEN_MARGIN_MS) return cached.token
    this.appTokens.delete(key)
    const issued = await new GitHubApp(app).installationToken(ref).catch((err: unknown) => {
      log.warn('installation token failed', { repo: key, err })
      return null
    })
    if (!issued) return null
    this.appTokens.set(key, { token: issued.token, expiresAt: Date.parse(issued.expiresAt) })
    return issued.token
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
