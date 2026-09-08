import type { Thread, ThreadListItem } from '@valet/shared'
import type { ThreadRow } from '../db/schema.js'

export function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    agent: row.agent,
    model: row.model,
    permissions: row.permissions,
    status: row.status,
    error: row.error,
    branch: row.branch,
    baseBranch: row.baseBranch,
    containerId: row.containerId,
    agentSessionId: row.agentSessionId,
    pr: row.pr ?? null,
    costUsd: row.costUsd,
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  }
}

export function toListItem(row: ThreadRow, projectName: string): ThreadListItem {
  return { ...toThread(row), projectName, diffStats: row.diffStats ?? null }
}

/** First line of the prompt, whitespace collapsed, at most 60 characters. */
export function titleFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'New thread'
  return cleaned.length > 60 ? `${cleaned.slice(0, 59).trimEnd()}…` : cleaned
}
