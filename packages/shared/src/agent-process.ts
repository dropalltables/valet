import type { PermissionMode } from './domain.js'

/**
 * The seam between agent adapters (Claude, Codex normalizers in core) and the
 * thing that actually runs the CLI.
 *
 * In production the runner is the supervisor `/exec` socket inside a sandbox; in
 * local development it can be `node:child_process` on this machine, which lets an
 * adapter be tested against a real CLI without Docker. Adapters must only use this
 * interface.
 */

export type SpawnOptions = {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

export interface AgentProcess {
  readonly pid: number | null
  /** Write to stdin (utf8). Rejects once stdin is closed or the process exited. */
  write(data: string): Promise<void>
  closeStdin(): Promise<void>
  /** SIGINT ends a Claude turn cleanly; SIGTERM stops the process. */
  signal(sig: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void>
  /** Resolves when the process exits. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  /** Newline-delimited stdout. Partial trailing line is delivered on exit. */
  onStdoutLine(cb: (line: string) => void): void
  onStderr(cb: (chunk: string) => void): void
}

export interface ProcessRunner {
  spawn(options: SpawnOptions): Promise<AgentProcess>
}

/**
 * What core asks an adapter to do. Adapters are stateful per thread: one adapter
 * instance owns at most one CLI process at a time.
 */
export type AdapterStartOptions = {
  runner: ProcessRunner
  cwd: string
  model: string
  /** One of the agent's `PERMISSION_MODES`. */
  permissions: PermissionMode
  /** Credential env for the CLI (`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_HOME`, ...). */
  env: Record<string, string>
  /** Resume this agent-side session when set (after a pause/wake or core restart). */
  resumeSessionId: string | null
  /** Extra instructions appended to the agent's system prompt. */
  systemPromptSuffix: string
  /**
   * Valet's generated MCP config in the sandbox, or null when no server applies.
   * Claude Code takes it as a flag; Codex reads its servers from `config.toml`.
   */
  mcpConfigPath: string | null
}
