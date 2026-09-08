import { stringify } from 'smol-toml'
import { SANDBOX } from '@valet/shared'

/**
 * An MCP server with its secrets decrypted, ready to be written into a sandbox.
 * Everything the generators below emit ends up in a 0600 file, never in argv.
 */
export type ResolvedMcpServer = { name: string } & (
  | { type: 'http'; url: string; headers: Record<string, string> }
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
)

/**
 * `--mcp-config` contents for Claude Code. `projectServers` are the entries of the
 * repository's own `.mcp.json`, passed through verbatim when the operator allows
 * them; Valet's servers win on a name collision.
 */
export function claudeMcpConfig(servers: ResolvedMcpServer[], projectServers: Record<string, unknown>): string {
  const mcpServers: Record<string, unknown> = { ...projectServers }
  for (const s of servers) {
    mcpServers[s.name] =
      s.type === 'http'
        ? { type: 'http', url: s.url, ...(Object.keys(s.headers).length > 0 ? { headers: s.headers } : {}) }
        : {
            type: 'stdio',
            command: s.command,
            ...(s.args.length > 0 ? { args: s.args } : {}),
            ...(Object.keys(s.env).length > 0 ? { env: s.env } : {}),
          }
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`
}

/**
 * `CODEX_HOME/config.toml`. Codex has no per-launch MCP flag, so the servers are
 * part of the config file core rewrites on every launch.
 *
 * `http_headers` carries the secret directly rather than `bearer_token_env_var`,
 * which would need the value in the `codex app-server` environment.
 */
export function codexConfigToml(servers: ResolvedMcpServer[]): string {
  const mcpServers: Record<string, unknown> = {}
  for (const s of servers) {
    mcpServers[s.name] =
      s.type === 'http'
        ? { url: s.url, ...(Object.keys(s.headers).length > 0 ? { http_headers: s.headers } : {}) }
        : {
            command: s.command,
            ...(s.args.length > 0 ? { args: s.args } : {}),
            ...(Object.keys(s.env).length > 0 ? { env: s.env } : {}),
          }
  }
  const config = {
    check_for_update_on_startup: false,
    cli_auth_credentials_store: 'file',
    analytics: { enabled: false },
    projects: { [SANDBOX.repo]: { trust_level: 'trusted' } },
    ...(servers.length > 0 ? { mcp_servers: mcpServers } : {}),
  }
  return `${stringify(config)}\n`
}
