import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SANDBOX } from '@valet/shared'
import { parse } from 'smol-toml'
import type { SupervisorClient } from '../src/docker/supervisor-client.js'
import { claudeMcpConfig, codexConfigToml, type ResolvedMcpServer } from '../src/mcp/config.js'
import { writeClaudeMcpConfig } from '../src/threads/sandbox-ops.js'

const http: ResolvedMcpServer = {
  name: 'github',
  type: 'http',
  url: 'https://api.githubcopilot.com/mcp/',
  headers: { Authorization: 'Bearer gh"p_\\x' },
}
const stdio: ResolvedMcpServer = {
  name: 'files',
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', SANDBOX.repo],
  env: { API_KEY: 'k1' },
}
const bare: ResolvedMcpServer = { name: 'bare', type: 'stdio', command: 'run-mcp', args: [], env: {} }

test('claude mcp config', () => {
  const config = JSON.parse(claudeMcpConfig([http, stdio, bare], {})) as { mcpServers: Record<string, unknown> }
  assert.deepEqual(config, {
    mcpServers: {
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer gh"p_\\x' } },
      files: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', SANDBOX.repo],
        env: { API_KEY: 'k1' },
      },
      bare: { type: 'stdio', command: 'run-mcp' },
    },
  })
})

test('claude mcp config merges the repository servers, valet winning', () => {
  const fromRepo = { github: { command: 'evil' }, repo: { type: 'stdio', command: 'run-repo-mcp' } }
  const config = JSON.parse(claudeMcpConfig([http], fromRepo)) as { mcpServers: Record<string, unknown> }
  assert.deepEqual(config.mcpServers, {
    repo: { type: 'stdio', command: 'run-repo-mcp' },
    github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer gh"p_\\x' } },
  })
})

test('codex config keeps its base settings', () => {
  const config = parse(codexConfigToml([]))
  assert.deepEqual(config, {
    check_for_update_on_startup: false,
    cli_auth_credentials_store: 'file',
    analytics: { enabled: false },
    projects: { [SANDBOX.repo]: { trust_level: 'trusted' } },
  })
})

test('codex mcp servers', () => {
  const config = parse(codexConfigToml([http, stdio, bare])) as { mcp_servers: Record<string, unknown> }
  assert.deepEqual(config.mcp_servers, {
    github: { url: 'https://api.githubcopilot.com/mcp/', http_headers: { Authorization: 'Bearer gh"p_\\x' } },
    files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', SANDBOX.repo], env: { API_KEY: 'k1' } },
    bare: { command: 'run-mcp' },
  })
})

/** Records what would be written into the sandbox, with `.mcp.json` as `repoFile`. */
function fakeSupervisor(repoFile: string | null) {
  const written: Array<{ path: string; data: string; mode: string | undefined }> = []
  const ran: string[][] = []
  const client = {
    fsRead: async (path: string) => (path === SANDBOX.projectMcpJson && repoFile !== null ? Buffer.from(repoFile) : null),
    fsWrite: async (path: string, data: Buffer | string, mode?: string) => {
      written.push({ path, data: data.toString(), mode })
    },
    run: async (req: { argv: string[] }) => {
      ran.push(req.argv)
      return { code: 0, stdout: '', stderr: '' }
    },
  } as unknown as SupervisorClient
  return { client, written, ran }
}

const logs: string[] = []
const sink = (level: 'info' | 'warn' | 'error', message: string): void => void logs.push(`${level}: ${message}`)
const REPO_MCP_JSON = '{"mcpServers":{"repo":{"command":"run-repo-mcp"}}}'

test('claude mcp config ignores the repository .mcp.json unless it is allowed', async () => {
  const off = fakeSupervisor(REPO_MCP_JSON)
  assert.equal(await writeClaudeMcpConfig(off.client, [http], false, sink), SANDBOX.mcpConfig)
  assert.equal(off.written.length, 1)
  assert.equal(off.written[0]?.mode, '600')
  assert.deepEqual(Object.keys(JSON.parse(off.written[0]?.data ?? '{}').mcpServers), ['github'])

  const on = fakeSupervisor(REPO_MCP_JSON)
  assert.equal(await writeClaudeMcpConfig(on.client, [http], true, sink), SANDBOX.mcpConfig)
  assert.deepEqual(Object.keys(JSON.parse(on.written[0]?.data ?? '{}').mcpServers), ['repo', 'github'])
})

test('claude mcp config is removed when nothing applies', async () => {
  const none = fakeSupervisor(REPO_MCP_JSON)
  assert.equal(await writeClaudeMcpConfig(none.client, [], false, sink), null)
  assert.deepEqual(none.written, [])
  assert.deepEqual(none.ran, [['rm', '-f', SANDBOX.mcpConfig]])

  const noRepoFile = fakeSupervisor(null)
  assert.equal(await writeClaudeMcpConfig(noRepoFile.client, [], true, sink), null)
  assert.deepEqual(noRepoFile.ran, [['rm', '-f', SANDBOX.mcpConfig]])
})

test('a malformed repository .mcp.json is reported and skipped', async () => {
  logs.length = 0
  const broken = fakeSupervisor('{ not json')
  assert.equal(await writeClaudeMcpConfig(broken.client, [http], true, sink), SANDBOX.mcpConfig)
  assert.deepEqual(Object.keys(JSON.parse(broken.written[0]?.data ?? '{}').mcpServers), ['github'])
  assert.match(logs.join(''), /^warn: ignoring \/home\/valet\/workspace\/repo\/\.mcp\.json: /)
})
