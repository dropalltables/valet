import type { Project, ProjectSnapshot } from '@valet/shared'
import type { ProjectRow } from '../db/schema.js'

function toSnapshot(row: ProjectRow): ProjectSnapshot | null {
  if (!row.snapshotKey || !row.snapshotBaseBranch || !row.snapshotVolume || !row.snapshotCreatedAt || !row.snapshotLastUsedAt) return null
  return {
    key: row.snapshotKey,
    baseBranch: row.snapshotBaseBranch,
    volume: row.snapshotVolume,
    sizeBytes: row.snapshotSizeBytes ?? 0,
    createdAt: row.snapshotCreatedAt.toISOString(),
    lastUsedAt: row.snapshotLastUsedAt.toISOString(),
  }
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    hasSetupScript: row.hasSetupScript,
    snapshot: toSnapshot(row),
    autoCreatePr: row.autoCreatePr,
    archiveOnMerge: row.archiveOnMerge,
    autoFixCi: row.autoFixCi,
    redactSecrets: row.redactSecrets,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
