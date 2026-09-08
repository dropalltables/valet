const CLAUDE_TOOLS: Record<string, string> = {
  Bash: 'bash',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Grep: 'grep',
  Glob: 'glob',
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
  TodoWrite: 'todo',
  Task: 'task',
  AskUserQuestion: 'question',
}

export function normalizeClaudeTool(vendorName: string): string {
  const known = CLAUDE_TOOLS[vendorName]
  if (known) return known
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(vendorName)
  if (mcp) return `mcp:${mcp[1]}:${mcp[2]}`
  return vendorName.toLowerCase()
}
