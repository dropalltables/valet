import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  AGENT_LABELS,
  DEFAULT_MODEL,
  DEFAULT_MODELS,
  type AgentInfo,
  type AgentKind,
  type AgentsResponse,
  type CredentialKind,
  type EventsResponse,
  type Health,
  type ProjectsResponse,
  type PushResponse,
  type SendMessageResponse,
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
import { GitHub } from '../git/github.js'
import { errorMessage, logger } from '../logger.js'
import type { ProjectService } from '../projects/service.js'
import type { SettingsService } from '../settings.js'
import { updateSettingsSchema } from '../settings.js'
import type { ThreadService } from '../threads/service.js'
import { jsonBody, queryParams } from './validate.js'

const log = logger('http')

export type AppDeps = {
  version: string
  db: Db
  auth: Auth
  docker: DockerClient
  events: EventLog
  credentials: CredentialStore
  deviceLogins: DeviceLoginManager
  settings: SettingsService
  projects: ProjectService
  threads: ThreadService
}

const imageSchema = z.object({ mediaType: z.string(), dataUrl: z.string() })
const agentKind = z.enum(['claude', 'codex'])
const credentialKind = z.enum(['claude', 'codex', 'github'])

const createProjectSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('github'),
    repoUrl: z.string().min(1),
    defaultBranch: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({ source: z.literal('blank'), name: z.string().min(1) }),
])
const updateProjectSchema = z.object({ name: z.string().optional(), defaultBranch: z.string().optional() })
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
const updateThreadSchema = z.object({ title: z.string().optional() })
const sendMessageSchema = z.object({
  text: z.string(),
  images: z.array(imageSchema).optional(),
  mode: z.enum(['queue', 'steer']).optional(),
})
const permissionSchema = z.object({ decision: z.enum(['allow', 'deny']) })
const answersSchema = z.object({ answers: z.record(z.string(), z.array(z.string())) })
const prSchema = z.object({ title: z.string().optional(), body: z.string().optional(), draft: z.boolean().optional() })
const putCredentialSchema = z.object({ token: z.string().optional(), apiKey: z.string().optional() })

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

  app.get('/api/agents', async (c) => {
    const [creds, settings] = await Promise.all([deps.credentials.list(), deps.settings.get()])
    const agents: AgentInfo[] = (['claude', 'codex'] as AgentKind[]).map((id) => {
      const cred = creds.find((s) => s.kind === id)
      const models = id === 'codex' && deps.threads.codexModels ? deps.threads.codexModels : [...DEFAULT_MODELS[id]]
      return {
        id,
        label: AGENT_LABELS[id],
        available: cred?.configured === true,
        reason: cred?.configured ? null : 'No credential configured',
        models,
        defaultModel: settings.defaultModel[id] ?? DEFAULT_MODEL[id],
      }
    })
    const body: AgentsResponse = { agents }
    return c.json(body)
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
    const token = await deps.credentials.githubToken()
    if (!token) throw badRequest('No GitHub credential is configured')
    return c.json(await new GitHub(token).listBranches({ owner: c.req.param('owner'), repo: c.req.param('repo') }))
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
        return c.json(await deps.credentials.put('claude', { token }, maskToken(token), method))
      }
      case 'codex': {
        const apiKey = body.apiKey?.trim()
        if (!apiKey) throw badRequest('apiKey is required')
        if (!apiKey.startsWith('sk-')) throw badRequest('apiKey must start with sk-')
        return c.json(await deps.credentials.put('codex', { apiKey }, maskToken(apiKey), 'api-key'))
      }
      case 'github': {
        const token = body.token?.trim()
        if (!token) throw badRequest('token is required')
        const login = await new GitHub(token).login()
        return c.json(await deps.credentials.put('github', { token }, `${login} (${maskToken(token)})`, null))
      }
    }
  })
  app.delete('/api/credentials/:kind', async (c) => {
    await deps.credentials.remove(parseKind(c.req.param('kind')))
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
    return c.json(await deps.threads.update(c.req.param('id'), body.title !== undefined ? { title: body.title } : {}))
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
