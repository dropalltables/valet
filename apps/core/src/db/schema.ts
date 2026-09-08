import { sql } from 'drizzle-orm'
import { bigint, bigserial, boolean, doublePrecision, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import type {
  AgentKind,
  DiffStats,
  ModelOption,
  ModelsSource,
  NotificationEvent,
  PermissionPolicy,
  ProjectSource,
  PullRequestState,
  Service,
  Settings,
  ThreadStatus,
  WebhookKind,
} from '@valet/shared'

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  source: text('source').$type<ProjectSource>().notNull(),
  repoUrl: text('repo_url'),
  defaultBranch: text('default_branch').notNull(),
  hasSetupScript: boolean('has_setup_script'),
  /** Warm-start snapshot of a home volume taken after `.valet/setup`; all null while none exists. */
  snapshotKey: text('snapshot_key'),
  /** Part of the key, but kept apart so a thread on another base branch is rejected before the volume is copied. */
  snapshotBaseBranch: text('snapshot_base_branch'),
  snapshotVolume: text('snapshot_volume'),
  snapshotSizeBytes: bigint('snapshot_size_bytes', { mode: 'number' }),
  snapshotCreatedAt: timestamp('snapshot_created_at', { withTimezone: true }),
  snapshotLastUsedAt: timestamp('snapshot_last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const projectEnvVars = pgTable(
  'project_env_vars',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    valueEnc: text('value_enc').notNull(),
    kind: text('kind').$type<'plain' | 'secret'>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.name] })],
)

export type PrRow = { url: string; number: number; state: PullRequestState }
/** A listening port as last reported by the sandbox; the URL is derived at read time. */
export type StoredPortal = { port: number; name: string | null; process: string | null }
/**
 * Share state per port (keyed by the port as a string). Tokens carry `generation`;
 * revoking bumps it, which invalidates every link and cookie issued before.
 */
export type PortalShare = { generation: number; expiresAt: string | null }

export const threads = pgTable(
  'threads',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    agent: text('agent').$type<AgentKind>().notNull(),
    model: text('model').notNull(),
    permissions: text('permissions').$type<PermissionPolicy>().notNull(),
    status: text('status').$type<ThreadStatus>().notNull(),
    error: text('error'),
    branch: text('branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    containerId: text('container_id'),
    volumeName: text('volume_name').notNull(),
    supervisorTokenEnc: text('supervisor_token_enc').notNull(),
    agentSessionId: text('agent_session_id'),
    pr: jsonb('pr').$type<PrRow>(),
    costUsd: doublePrecision('cost_usd'),
    diffStats: jsonb('diff_stats').$type<DiffStats>(),
    portals: jsonb('portals').$type<StoredPortal[]>(),
    portalShares: jsonb('portal_shares').$type<Record<string, PortalShare>>(),
    /** Managed services as last reported by the sandbox supervisor; kept while paused. */
    services: jsonb('services').$type<Service[]>(),
    firstPrompt: text('first_prompt').notNull(),
    /** Set once the repo is cloned and the branch exists on the home volume. */
    repoReady: boolean('repo_ready').notNull().default(false),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('threads_project_idx').on(t.projectId), index('threads_status_idx').on(t.status)],
)

export const threadEvents = pgTable(
  'thread_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('thread_events_thread_seq_idx').on(t.threadId, t.seq),
    // Usage rollups scan one event type over a date range; rate limits read the
    // newest `usage` event. Both are partial so they stay small next to the log.
    index('thread_events_turn_end_idx').on(t.createdAt).where(sql`${t.type} = 'turn.end'`),
    index('thread_events_usage_idx').on(t.id.desc()).where(sql`${t.type} = 'usage'`),
  ],
)

export const credentials = pgTable('credentials', {
  kind: text('kind').$type<'claude' | 'codex' | 'github'>().primaryKey(),
  payloadEnc: text('payload_enc').notNull(),
  label: text('label'),
  method: text('method').$type<'oauth' | 'api-key'>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const settings = pgTable('settings', {
  id: text('id').primaryKey(),
  data: jsonb('data').$type<Partial<Settings>>().notNull(),
  /** Web Push application server keys, generated on first use. Null until then. */
  vapidPublicKey: text('vapid_public_key'),
  vapidPrivateKeyEnc: text('vapid_private_key_enc'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** One row per browser that enabled push; `endpoint` is the URL its push service issued. */
export const pushSubscriptions = pgTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Outbound notification target. `secretEnc` is the HMAC key for `generic` webhooks,
 * and `position` is the index the operator submitted, which is the order shown back.
 */
export const webhooks = pgTable('webhooks', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<WebhookKind>().notNull(),
  url: text('url').notNull(),
  secretEnc: text('secret_enc'),
  events: jsonb('events').$type<NotificationEvent[]>().notNull(),
  position: integer('position').notNull(),
})

/**
 * One row. Owner portal cookies embed `portal_owner_generation`; logging out bumps
 * it, which is the only way to revoke cookies that live on the portal hosts.
 */
export const authState = pgTable('auth_state', {
  id: text('id').primaryKey(),
  portalOwnerGeneration: integer('portal_owner_generation').notNull().default(0),
})

export const deviceLogins = pgTable('device_logins', {
  id: text('id').primaryKey(),
  status: text('status').$type<'pending' | 'complete' | 'failed' | 'expired'>().notNull(),
  verificationUrl: text('verification_url').notNull(),
  userCode: text('user_code').notNull(),
  error: text('error'),
  containerId: text('container_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Model list per agent as last reported by its CLI. `source` is `default` (and
 * `models` empty) while no refresh has succeeded; a failed refresh only sets `error`.
 */
export const modelCatalog = pgTable('model_catalog', {
  agent: text('agent').$type<AgentKind>().primaryKey(),
  models: jsonb('models').$type<ModelOption[]>().notNull(),
  source: text('source').$type<ModelsSource>().notNull(),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
  error: text('error'),
})

export type ProjectRow = typeof projects.$inferSelect
export type ThreadRow = typeof threads.$inferSelect
export type ThreadEventRow = typeof threadEvents.$inferSelect
export type CredentialRow = typeof credentials.$inferSelect
export type DeviceLoginRow = typeof deviceLogins.$inferSelect
export type ModelCatalogRow = typeof modelCatalog.$inferSelect
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect
export type WebhookRow = typeof webhooks.$inferSelect
