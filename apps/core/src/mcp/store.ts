import { and, asc, count, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { MCP_SERVER_NAME_RE, type McpServer, type McpServerInput, type McpServerScope, type McpValue, type McpValueInput } from '@valet/shared'
import type { Cipher } from '../crypto.js'
import type { Db } from '../db/index.js'
import { mcpServerProjects, mcpServers, projects, type McpServerRow } from '../db/schema.js'
import { badRequest, conflict, notFound } from '../errors.js'
import { newId } from '../ids.js'
import type { ResolvedMcpServer } from './config.js'

const VALUE_NAME_RE = /^[^\s:]+$/

/** Header/environment names and values, in the order the caller listed them. */
type Values = Record<string, string>

type Validated = { columns: Omit<McpServerRow, 'id' | 'createdAt' | 'updatedAt'>; projectIds: string[] }

function requireString(value: string | null, field: string): string {
  if (!value) throw new Error(`mcp server row is missing ${field}`)
  return value
}

function names(values: Values): McpValue[] {
  return Object.keys(values).map((name) => ({ name }))
}

/**
 * The header or environment map to store. An entry without a `value` keeps the one
 * already stored under that name, which is how editing a server avoids re-entering
 * its secrets; `previous` is null when there is nothing to keep.
 *
 * The map is prototype-free so a name like `constructor` is a plain key.
 */
export function resolveValues(entries: McpValueInput[], previous: Values | null): Values {
  const values: Values = Object.create(null) as Values
  for (const entry of entries) {
    const name = entry.name.trim()
    if (!VALUE_NAME_RE.test(name)) throw badRequest(`invalid name: ${entry.name}`)
    if (Object.hasOwn(values, name)) throw badRequest(`duplicate name: ${name}`)
    const value = entry.value ?? (previous && Object.hasOwn(previous, name) ? previous[name] : undefined)
    if (value === undefined) throw badRequest(`value is required for ${name}`)
    values[name] = value
  }
  return values
}

/** The stored url for an http server: an absolute http(s) URL, in normal form. */
export function resolveUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw badRequest('url must be http or https')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw badRequest('url must be http or https')
  return parsed.toString()
}

/** Folds the enabled-server rows of `counts()` into a lookup by project id. */
export function countLookup(rows: Array<{ scope: McpServerScope; projectId: string | null }>): (projectId: string) => number {
  let everywhere = 0
  const byProject = new Map<string, number>()
  for (const row of rows) {
    // A server that applies everywhere has no project links; see setProjects.
    if (row.scope === 'all') everywhere += 1
    else if (row.projectId) byProject.set(row.projectId, (byProject.get(row.projectId) ?? 0) + 1)
  }
  return (projectId) => everywhere + (byProject.get(projectId) ?? 0)
}

export class McpServerStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}

  private values(row: McpServerRow): Values {
    return this.cipher.decryptJson<Values>(row.valuesEnc)
  }

  private toServer(row: McpServerRow, projectIds: string[]): McpServer {
    const base = {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      scope: row.scope,
      projectIds,
      updatedAt: row.updatedAt.toISOString(),
    }
    const values = names(this.values(row))
    return row.type === 'http'
      ? { ...base, type: 'http', url: requireString(row.url, 'url'), headers: values }
      : { ...base, type: 'stdio', command: requireString(row.command, 'command'), args: row.args, env: values }
  }

  async list(): Promise<McpServer[]> {
    const rows = await this.db.select().from(mcpServers).orderBy(asc(mcpServers.name))
    if (rows.length === 0) return []
    const links = await this.db.select().from(mcpServerProjects)
    return rows.map((row) =>
      this.toServer(
        row,
        links.filter((l) => l.serverId === row.id).map((l) => l.projectId),
      ),
    )
  }

  async get(id: string): Promise<McpServer> {
    const row = await this.row(id)
    const links = await this.db.select().from(mcpServerProjects).where(eq(mcpServerProjects.serverId, id))
    return this.toServer(
      row,
      links.map((l) => l.projectId),
    )
  }

  private async row(id: string): Promise<McpServerRow> {
    const [row] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id))
    if (!row) throw notFound('mcp server')
    return row
  }

  /**
   * Validated columns for an insert or update. `previous` supplies the values of
   * entries whose `value` the caller omitted, so editing a server does not require
   * re-entering its secrets.
   */
  private async validate(input: McpServerInput, previous: Values | null): Promise<Validated> {
    const name = input.name.trim()
    if (!MCP_SERVER_NAME_RE.test(name))
      throw badRequest('name must start with a letter or digit and contain only letters, digits, hyphens, or underscores')
    const scope = input.scope ?? 'all'
    const projectIds = scope === 'selected' ? [...new Set(input.projectIds ?? [])] : []
    if (scope === 'selected' && projectIds.length === 0) throw badRequest('select at least one project')
    if (projectIds.length > 0) {
      const found = await this.db.select({ id: projects.id }).from(projects).where(inArray(projects.id, projectIds))
      if (found.length !== projectIds.length) throw badRequest('unknown project')
    }

    const values = resolveValues(input.type === 'http' ? input.headers : input.env, previous)

    const common = {
      name,
      enabled: input.enabled ?? true,
      scope,
      valuesEnc: this.cipher.encryptJson(values),
    }
    if (input.type === 'http') {
      return { columns: { ...common, type: 'http', url: resolveUrl(input.url), command: null, args: [] }, projectIds }
    }
    const command = input.command.trim()
    if (!command) throw badRequest('command is required')
    const args = (input.args ?? []).map((a) => a.trim()).filter((a) => a !== '')
    return { columns: { ...common, type: 'stdio', url: null, command, args }, projectIds }
  }

  private async setProjects(serverId: string, projectIds: string[]): Promise<void> {
    await this.db.delete(mcpServerProjects).where(eq(mcpServerProjects.serverId, serverId))
    if (projectIds.length > 0) {
      await this.db.insert(mcpServerProjects).values(projectIds.map((projectId) => ({ serverId, projectId })))
    }
  }

  private async requireNameFree(name: string, exceptId: string | null): Promise<void> {
    const [taken] = await this.db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, name))
    if (taken && taken.id !== exceptId) throw conflict(`a server named ${name} already exists`)
  }

  async create(input: McpServerInput): Promise<McpServer> {
    const { columns, projectIds } = await this.validate(input, null)
    await this.requireNameFree(columns.name, null)
    const id = newId()
    await this.db.insert(mcpServers).values({ id, ...columns })
    await this.setProjects(id, projectIds)
    return this.get(id)
  }

  async update(id: string, input: McpServerInput): Promise<McpServer> {
    const existing = await this.row(id)
    // Values only carry over within a transport: an http header must not become the
    // environment of a process the stdio form would spawn.
    const { columns, projectIds } = await this.validate(input, input.type === existing.type ? this.values(existing) : null)
    await this.requireNameFree(columns.name, id)
    await this.db
      .update(mcpServers)
      .set({ ...columns, updatedAt: new Date() })
      .where(eq(mcpServers.id, id))
    await this.setProjects(id, projectIds)
    return this.get(id)
  }

  async remove(id: string): Promise<void> {
    await this.row(id)
    await this.db.delete(mcpServers).where(eq(mcpServers.id, id))
  }

  /** Enabled servers that apply to `projectId`, decrypted for writing into a sandbox. */
  async forProject(projectId: string): Promise<ResolvedMcpServer[]> {
    const rows = await this.db
      .select({ server: mcpServers })
      .from(mcpServers)
      .leftJoin(
        mcpServerProjects,
        and(eq(mcpServerProjects.serverId, mcpServers.id), eq(mcpServerProjects.projectId, projectId)),
      )
      .where(and(eq(mcpServers.enabled, true), or(eq(mcpServers.scope, 'all'), isNotNull(mcpServerProjects.serverId))))
      .orderBy(asc(mcpServers.name))
    return rows.map(({ server }) => {
      const values = this.values(server)
      return server.type === 'http'
        ? { name: server.name, type: 'http', url: requireString(server.url, 'url'), headers: values }
        : { name: server.name, type: 'stdio', command: requireString(server.command, 'command'), args: server.args, env: values }
    })
  }

  /** How many enabled servers apply to one project. */
  async countFor(projectId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(mcpServers)
      .leftJoin(
        mcpServerProjects,
        and(eq(mcpServerProjects.serverId, mcpServers.id), eq(mcpServerProjects.projectId, projectId)),
      )
      .where(and(eq(mcpServers.enabled, true), or(eq(mcpServers.scope, 'all'), isNotNull(mcpServerProjects.serverId))))
    return row?.n ?? 0
  }

  /** One snapshot of the enabled-server counts, as a lookup by project id. */
  async counts(): Promise<(projectId: string) => number> {
    const rows = await this.db
      .select({ scope: mcpServers.scope, projectId: mcpServerProjects.projectId })
      .from(mcpServers)
      .leftJoin(mcpServerProjects, eq(mcpServerProjects.serverId, mcpServers.id))
      .where(eq(mcpServers.enabled, true))
    return countLookup(rows)
  }
}
