import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  AGENT_LABELS,
  DEFAULT_MODEL,
  GITHUB_WEBHOOK_PATH,
  createServiceRequestSchema,
  serviceNameSchema,
  type AgentInfo,
  type AgentKind,
  type AgentsResponse,
  type CredentialKind,
  type EventsResponse,
  type GitHubAppResponse,
  type Health,
  type PortalsResponse,
  type ProjectsResponse,
  type PushResponse,
  type SendMessageResponse,
  type ServicesResponse,
  type ThreadsResponse,
} from '@valet/shared'
import type { Auth } from '../auth.js'
import type { CredentialStore } from '../credentials/store.js'
import { maskToken } from '../credentials/store.js'
import type { DeviceLoginManager } from '../credentials/device-login.js'
import type { Db } from '../db/index.js'
import type { DockerClient } from '../docker/client.js'
import { HttpError, badRequest, notFound, statusOf } from '../errors.js'
import type { EventLog } from '../events/log.js'
import type { Config } from '../config.js'
import { GitHub, GitHubApp } from '../git/github.js'
import { parseWebhookEvent, verifyWebhookSignature, type WebhookIntent } from '../git/webhook.js'
import { errorMessage, logger } from '../logger.js'
import type { ModelCatalog } from '../models/catalog.js'
import type { PortalGateway } from '../portals/gateway.js'
import type { ProjectService } from '../projects/service.js'
import type { SettingsService } from '../settings.js'
import { updateSettingsSchema } from '../settings.js'
import type { ThreadService, WebhookOutcome } from '../threads/service.js'
import { jsonBody, queryParams } from './validate.js'

const log = logger('http')

export type AppDeps = {
  version: string
  cfg: Config
  db: Db
  auth: Auth
  docker: DockerClient
  events: EventLog
  credentials: CredentialStore
  deviceLogins: DeviceLoginManager
  catalog: ModelCatalog
  settings: SettingsService
  projects: ProjectService
  threads: ThreadService
  portals: PortalGateway
}

const imageSchema = z.object({ mediaType: z.string(), dataUrl: z.string() })
const agentKind = z.enum(['claude', 'codex'])
const credentialKind = z.enum(['claude', 'codex', 'github', 'github-app'])

const createProjectSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('github'),
    repoUrl: z.string().min(1),
    defaultBranch: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({ source: z.literal('blank'), name: z.string().min(1) }),
])
const updateProjectSchema = z.object({
  name: z.string().optional(),
  defaultBranch: z.string().optional(),
  autoCreatePr: z.boolean().optional(),
  archiveOnMerge: z.boolean().optional(),
  autoFixCi: z.boolean().optional(),
})
const putEnvSchema = z.object({
  vars: z.array(z.object({ name: z.string(), value: z.string().optional(), kind: z.enum(['plain', 'secret']) })),
})
const createThreadSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string(),
  images: z.array(imageSchema).optional(),
  agent: agentKind,
  model: z.string().min(1),
  permissions: z.enum(['auto', 'ask']).optional(),
  baseBranch: z.string().optional(),
})
const updateThreadSchema = z.object({ title: z.string().optional(), autoFixCi: z.boolean().optional() })
const sendMessageSchema = z.object({
  text: z.string(),
  images: z.array(imageSchema).optional(),
  mode: z.enum(['queue', 'steer']).optional(),
})
const permissionSchema = z.object({ decision: z.enum(['allow', 'deny']) })
const answersSchema = z.object({ answers: z.record(z.string(), z.array(z.string())) })
const prSchema = z.object({ title: z.string().optional(), body: z.string().optional(), draft: z.boolean().optional() })
const putCredentialSchema = z.object({
  token: z.string().optional(),
  apiKey: z.string().optional(),
  appId: z.number().int().positive().optional(),
  privateKey: z.string().optional(),
  webhookSecret: z.string().optional(),
})
const shareSchema = z.object({ hours: z.union([z.literal(1), z.literal(3), z.literal(24), z.literal(168)]) })

function parsePort(raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('invalid port')
  return port
}

function parseServiceName(raw: string): string {
  const parsed = serviceNameSchema.safeParse(raw)
  if (!parsed.success) throw notFound('service')
  return parsed.data
}

const logLinesSchema = z.object({ lines: z.coerce.number().int().min(0).max(10_000).default(200) })

function parseKind(raw: string): CredentialKind {
  const parsed = credentialKind.safeParse(raw)
  if (!parsed.success) throw notFound('credential kind')
  return parsed.data
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400)
    const status = statusOf(err)
    if (status && status >= 400 && status < 600) return c.json({ error: errorMessage(err) }, status as 400)
    log.error('unhandled error', { path: c.req.path, err })
    return c.json({ error: errorMessage(err) }, 500)
  })
  app.notFound((c) => c.json({ error: 'not found' }, 404))
  // Portal traffic authenticates with its own cookie, so it is mounted ahead of the session check.
  app.route('/', deps.portals.routes())

  // GitHub authenticates itself by signing the body, so this one is mounted ahead of it too.
  app.post(GITHUB_WEBHOOK_PATH, async (c) => {
    const githubApp = await deps.credentials.githubApp()
    if (!githubApp) throw new HttpError(503, 'No GitHub App is configured')
    const raw = await c.req.text()
    if (!verifyWebhookSignature(githubApp.webhookSecret, raw, c.req.header('x-hub-signature-256'))) {
      throw new HttpError(401, 'signature mismatch')
    }
    const event = c.req.header('x-github-event') ?? ''
    const delivery = c.req.header('x-github-delivery')
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      throw badRequest('body is not JSON')
    }
    let intent: WebhookIntent | null
    try {
      intent = parseWebhookEvent(event, payload)
    } catch (err) {
      // A signed delivery whose shape Valet does not know is GitHub schema drift,
      // not a server fault.
      log.warn('unexpected github webhook payload', { event, delivery, message: errorMessage(err) })
      throw badRequest(`unexpected ${event} payload`)
    }
    const outcome: WebhookOutcome = intent ? await deps.threads.applyWebhook(intent) : 'ignored'
    log.info('github webhook', { event, delivery, kind: intent?.kind ?? null, outcome })
    return c.json({ outcome }, 202)
  })

  app.use('/api/*', deps.auth.middleware())
  app.route('/', deps.auth.routes())

  // ---- health --------------------------------------------------------------------

  app.get('/api/health', async (c) => {
    const [db, docker, image] = await Promise.all([
      deps.db
        .execute(sql`select 1`)
        .then(() => ({ ok: true, error: null }))
        .catch((err: unknown) => ({ ok: false, error: errorMessage(err) })),
      deps.docker
        .ping()
        .then(() => ({ ok: true, error: null }))
        .catch((err: unknown) => ({ ok: false, error: errorMessage(err) })),
      deps.docker.imageStatus().catch(() => null),
    ])
    const body: Health = {
      ok: db.ok && docker.ok,
      version: deps.version,
      db,
      docker,
      sandboxImage: image ?? { image: deps.docker.imageName, present: false, imageId: null, createdAt: null },
      authEnabled: deps.auth.enabled,
    }
    return c.json(body)
  })

  // ---- settings -------------------------------------------------------------------

  app.get('/api/settings', async (c) => c.json(await deps.settings.get()))
  app.put('/api/settings', jsonBody(updateSettingsSchema), async (c) => c.json(await deps.settings.update(c.req.valid('json'))))

  // ---- agents ----------------------------------------------------------------------

  const agentsResponse = async (): Promise<AgentsResponse> => {
    const [creds, settings, catalog] = await Promise.all([deps.credentials.list(), deps.settings.get(), deps.catalog.all()])
    const agents: AgentInfo[] = (['claude', 'codex'] as AgentKind[]).map((id) => {
      const cred = creds.find((s) => s.kind === id)
      const entry = catalog[id]
      const preferred = settings.defaultModel[id] ?? DEFAULT_MODEL[id]
      const fallback = entry.models.find((m) => m.default) ?? entry.models[0]
      return {
        id,
        label: AGENT_LABELS[id],
        available: cred?.configured === true,
        reason: cred?.configured ? null : 'No credential configured',
        models: entry.models,
        defaultModel: entry.models.some((m) => m.id === preferred) ? preferred : (fallback?.id ?? preferred),
        modelsSource: entry.source,
        modelsRefreshedAt: entry.refreshedAt?.toISOString() ?? null,
        modelsError: entry.error,
      }
    })
    return { agents }
  }

  app.get('/api/agents', async (c) => c.json(await agentsResponse()))
  app.post('/api/agents/refresh', queryParams(z.object({ agent: agentKind.optional() })), async (c) => {
    const { agent } = c.req.valid('query')
    const targets: AgentKind[] = agent ? [agent] : ['claude', 'codex']
    await Promise.all(targets.map((a) => deps.catalog.refresh(a)))
    return c.json(await agentsResponse())
  })

  // ---- credentials -------------------------------------------------------------------

  app.get('/api/credentials', async (c) => c.json(await deps.credentials.list()))

  app.post('/api/credentials/codex/device-login', async (c) => c.json(await deps.deviceLogins.start()))
  app.get('/api/credentials/codex/device-login/:id', async (c) => {
    const login = await deps.deviceLogins.get(c.req.param('id'))
    if (!login) throw notFound('device login')
    return c.json(login)
  })

  app.get('/api/credentials/github/repos', async (c) => {
    const token = await deps.credentials.githubToken()
    if (!token) throw badRequest('No GitHub credential is configured')
    return c.json({ repos: await new GitHub(token).listRepos(c.req.query('query')) })
  })
  app.get('/api/credentials/github/repos/:owner/:repo/branches', async (c) => {
    const ref = { owner: c.req.param('owner'), repo: c.req.param('repo') }
    const token = await deps.credentials.githubTokenFor(ref)
    if (!token) throw badRequest('No GitHub credential is configured')
    return c.json(await new GitHub(token).listBranches(ref))
  })

  app.get('/api/credentials/github/app', async (c) => {
    const githubApp = await deps.credentials.githubApp()
    const webhookUrl = `${deps.cfg.VALET_BASE_URL.replace(/\/$/, '')}${GITHUB_WEBHOOK_PATH}`
    if (!githubApp) {
      const body: GitHubAppResponse = { webhookUrl, installations: [], error: null }
      return c.json(body)
    }
    const body: GitHubAppResponse = await new GitHubApp(githubApp)
      .installations()
      .then((installations) => ({ webhookUrl, installations, error: null }))
      .catch((err: unknown) => ({ webhookUrl, installations: [], error: errorMessage(err) }))
    return c.json(body)
  })

  app.put('/api/credentials/:kind', jsonBody(putCredentialSchema), async (c) => {
    const kind = parseKind(c.req.param('kind'))
    const body = c.req.valid('json')
    switch (kind) {
      case 'claude': {
        const token = body.token?.trim()
        if (!token) throw badRequest('token is required')
        if (!token.startsWith('sk-ant-')) throw badRequest('token must start with sk-ant-')
        const method = token.startsWith('sk-ant-oat') ? 'oauth' : 'api-key'
        const status = await deps.credentials.put('claude', { token }, maskToken(token), method)
        void deps.catalog.refresh('claude')
        return c.json(status)
      }
      case 'codex': {
        const apiKey = body.apiKey?.trim()
        if (!apiKey) throw badRequest('apiKey is required')
        if (!apiKey.startsWith('sk-')) throw badRequest('apiKey must start with sk-')
        const status = await deps.credentials.put('codex', { apiKey }, maskToken(apiKey), 'api-key')
        void deps.catalog.refresh('codex')
        return c.json(status)
      }
      case 'github': {
        const token = body.token?.trim()
        if (!token) throw badRequest('token is required')
        const login = await new GitHub(token).login()
        return c.json(await deps.credentials.put('github', { token }, `${login} (${maskToken(token)})`, null))
      }
      case 'github-app': {
        const { appId } = body
        const privateKey = body.privateKey?.trim()
        const webhookSecret = body.webhookSecret?.trim()
        if (appId === undefined) throw badRequest('appId is required')
        if (!privateKey) throw badRequest('privateKey is required')
        if (!webhookSecret) throw badRequest('webhookSecret is required')
        if (!privateKey.includes('PRIVATE KEY')) throw badRequest('privateKey must be the PEM file GitHub generated')
        // A key that cannot sign fails locally, without an HTTP status of its own.
        const installations = await new GitHubApp({ appId, privateKey }).installations().catch((err: unknown) => {
          if (err instanceof HttpError || statusOf(err)) throw err
          throw badRequest(`GitHub App credentials were rejected: ${errorMessage(err)}`)
        })
        const label = installations[0] ? `App ${appId} (${installations[0].account})` : `App ${appId}`
        return c.json(await deps.credentials.put('github-app', { appId, privateKey, webhookSecret }, label, null))
      }
    }
  })
  app.delete('/api/credentials/:kind', async (c) => {
    const kind = parseKind(c.req.param('kind'))
    await deps.credentials.remove(kind)
    if (kind === 'claude' || kind === 'codex') await deps.catalog.clear(kind)
    return c.body(null, 204)
  })

  // ---- projects -----------------------------------------------------------------------

  app.get('/api/projects', async (c) => {
    const body: ProjectsResponse = { projects: await deps.projects.list() }
    return c.json(body)
  })
  app.post('/api/projects', jsonBody(createProjectSchema), async (c) => c.json(await deps.projects.create(c.req.valid('json')), 201))
  app.get('/api/projects/:id', async (c) => c.json(await deps.projects.get(c.req.param('id'))))
  app.patch('/api/projects/:id', jsonBody(updateProjectSchema), async (c) =>
    c.json(await deps.projects.update(c.req.param('id'), c.req.valid('json'))),
  )
  app.delete('/api/projects/:id', async (c) => {
    const id = c.req.param('id')
    await deps.projects.get(id)
    const force = c.req.query('force') === '1' || c.req.query('force') === 'true'
    const rows = await deps.threads.listForProject(id)
    if (rows.length > 0 && !force) throw new HttpError(409, 'project still has threads')
    for (const row of rows) await deps.threads.delete(row.id)
    await deps.projects.remove(id)
    return c.body(null, 204)
  })
  app.get('/api/projects/:id/env', async (c) => c.json({ vars: await deps.projects.listEnv(c.req.param('id')) }))
  app.put('/api/projects/:id/env', jsonBody(putEnvSchema), async (c) =>
    c.json({ vars: await deps.projects.putEnv(c.req.param('id'), c.req.valid('json')) }),
  )

  // ---- threads ---------------------------------------------------------------------------

  app.get('/api/threads', async (c) => {
    const archived = c.req.query('archived') === '1' || c.req.query('archived') === 'true'
    const body: ThreadsResponse = { threads: await deps.threads.list(archived) }
    return c.json(body)
  })
  app.post('/api/threads', jsonBody(createThreadSchema), async (c) => {
    const body = c.req.valid('json')
    const thread = await deps.threads.create({
      projectId: body.projectId,
      prompt: body.prompt,
      agent: body.agent,
      model: body.model,
      ...(body.images ? { images: body.images } : {}),
      ...(body.permissions ? { permissions: body.permissions } : {}),
      ...(body.baseBranch ? { baseBranch: body.baseBranch } : {}),
    })
    return c.json(thread, 201)
  })
  app.get('/api/threads/:id', async (c) => c.json(await deps.threads.get(c.req.param('id'))))
  app.patch('/api/threads/:id', jsonBody(updateThreadSchema), async (c) => {
    const body = c.req.valid('json')
    return c.json(
      await deps.threads.update(c.req.param('id'), {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.autoFixCi !== undefined ? { autoFixCi: body.autoFixCi } : {}),
      }),
    )
  })
  app.delete('/api/threads/:id', async (c) => {
    await deps.threads.delete(c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/api/threads/:id/messages', jsonBody(sendMessageSchema), async (c) => {
    const body = c.req.valid('json')
    const res: SendMessageResponse = await deps.threads.sendMessage(c.req.param('id'), {
      text: body.text,
      ...(body.images ? { images: body.images } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
    })
    return c.json(res, 202)
  })
  app.post('/api/threads/:id/interrupt', async (c) => {
    await deps.threads.interrupt(c.req.param('id'))
    return c.body(null, 204)
  })
  app.post('/api/threads/:id/pause', async (c) => c.json(await deps.threads.pause(c.req.param('id'))))
  app.post('/api/threads/:id/wake', async (c) => c.json(await deps.threads.wake(c.req.param('id'))))
  app.post('/api/threads/:id/archive', async (c) => c.json(await deps.threads.archive(c.req.param('id'))))
  app.post('/api/threads/:id/unarchive', async (c) => c.json(await deps.threads.unarchive(c.req.param('id'))))

  app.post('/api/threads/:id/permissions/:requestId', jsonBody(permissionSchema), async (c) => {
    await deps.threads.answerPermission(c.req.param('id'), c.req.param('requestId'), c.req.valid('json').decision)
    return c.body(null, 204)
  })
  app.post('/api/threads/:id/questions/:requestId', jsonBody(answersSchema), async (c) => {
    await deps.threads.answerQuestion(c.req.param('id'), c.req.param('requestId'), c.req.valid('json').answers)
    return c.body(null, 204)
  })

  app.get(
    '/api/threads/:id/events',
    queryParams(
      z.object({
        since: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(2000).default(500),
      }),
    ),
    async (c) => {
      await deps.threads.get(c.req.param('id'))
      const { since, limit } = c.req.valid('query')
      const body: EventsResponse = await deps.events.replay(c.req.param('id'), since, limit)
      return c.json(body)
    },
  )

  app.get('/api/threads/:id/changes', async (c) => c.json(await deps.threads.changes(c.req.param('id'))))
  app.get('/api/threads/:id/files', async (c) => c.json(await deps.threads.files(c.req.param('id'), c.req.query('path') ?? '')))
  app.get('/api/threads/:id/file', async (c) => c.json(await deps.threads.file(c.req.param('id'), c.req.query('path') ?? '')))

  app.get('/api/threads/:id/portals', async (c) => {
    const body: PortalsResponse = { portals: await deps.threads.portals(c.req.param('id')) }
    return c.json(body)
  })
  app.get('/api/threads/:id/portals/:port/auth', async (c) =>
    c.json(await deps.portals.authUrl(c.req.param('id'), parsePort(c.req.param('port')), c.req.query('path') ?? '/')),
  )
  app.post('/api/threads/:id/portals/:port/share', jsonBody(shareSchema), async (c) =>
    c.json(await deps.portals.share(c.req.param('id'), parsePort(c.req.param('port')), c.req.valid('json').hours)),
  )
  app.delete('/api/threads/:id/portals/:port/share', async (c) => {
    await deps.portals.revoke(c.req.param('id'), parsePort(c.req.param('port')))
    return c.body(null, 204)
  })

  app.get('/api/threads/:id/services', async (c) => {
    const body: ServicesResponse = { services: await deps.threads.services(c.req.param('id')) }
    return c.json(body)
  })
  app.post('/api/threads/:id/services', jsonBody(createServiceRequestSchema), async (c) =>
    c.json(await deps.threads.createService(c.req.param('id'), c.req.valid('json')), 201),
  )
  app.post('/api/threads/:id/services/:name/:action{start|stop|restart}', async (c) =>
    c.json(await deps.threads.serviceAction(c.req.param('id'), parseServiceName(c.req.param('name')), c.req.param('action') as 'start' | 'stop' | 'restart')),
  )
  app.delete('/api/threads/:id/services/:name', async (c) => {
    await deps.threads.removeService(c.req.param('id'), parseServiceName(c.req.param('name')))
    return c.body(null, 204)
  })
  app.get('/api/threads/:id/services/:name/logs', queryParams(logLinesSchema), async (c) =>
    c.text(await deps.threads.serviceLogs(c.req.param('id'), parseServiceName(c.req.param('name')), c.req.valid('query').lines)),
  )

  app.post('/api/threads/:id/push', async (c) => {
    const { branch } = await deps.threads.push(c.req.param('id'))
    const body: PushResponse = { branch, pushed: true }
    return c.json(body)
  })
  app.post('/api/threads/:id/pr', jsonBody(prSchema), async (c) => {
    const body = c.req.valid('json')
    return c.json(
      await deps.threads.createPr(c.req.param('id'), {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.draft !== undefined ? { draft: body.draft } : {}),
      }),
    )
  })

  return app
}
