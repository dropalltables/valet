import type {
  AgentKind,
  AgentsResponse,
  ChangesResponse,
  CreatePrRequest,
  CreateProjectRequest,
  CreateServiceRequest,
  CreateServiceResponse,
  CreateThreadRequest,
  CredentialKind,
  CredentialStatus,
  CredentialsResponse,
  DeviceLogin,
  EventsResponse,
  FileResponse,
  FilesResponse,
  GitHubBranchesResponse,
  GitHubReposResponse,
  Health,
  LoginRequest,
  PermissionDecisionRequest,
  PortalAuthUrlResponse,
  PortalsResponse,
  Project,
  ProjectEnvResponse,
  ProjectsResponse,
  PushResponse,
  PutCredentialRequest,
  PutProjectEnvRequest,
  QuestionAnswerRequest,
  SendMessageRequest,
  SendMessageResponse,
  ServicesResponse,
  SessionResponse,
  Settings,
  SharePortalRequest,
  SharePortalResponse,
  Thread,
  ThreadListItem,
  ThreadsResponse,
  UpdateProjectRequest,
  UpdateSettingsRequest,
  UpdateThreadRequest,
} from '@valet/shared'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const res = await fetch(path, { ...init, headers, credentials: 'include' })
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/api/auth/')) {
    const next = window.location.pathname + window.location.search
    window.location.assign(next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`)
  }
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (typeof body.error === 'string') message = body.error
    } catch {
      // Non-JSON error body; keep the status text.
    }
    throw new ApiError(res.status, message)
  }
  if (res.status === 204) return undefined as T
  if (res.headers.get('content-type')?.startsWith('text/plain')) return (await res.text()) as T
  return (await res.json()) as T
}

const json = (body: unknown): string => JSON.stringify(body)
const q = (params: Record<string, string | number | undefined>): string => {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v))
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const api = {
  auth: {
    login: (body: LoginRequest) => request<void>('/api/auth/login', { method: 'POST', body: json(body) }),
    session: () => request<SessionResponse>('/api/auth/session'),
  },
  health: () => request<Health>('/api/health'),
  settings: {
    get: () => request<Settings>('/api/settings'),
    update: (body: UpdateSettingsRequest) => request<Settings>('/api/settings', { method: 'PUT', body: json(body) }),
  },
  credentials: {
    list: () => request<CredentialsResponse>('/api/credentials'),
    put: (kind: CredentialKind, body: PutCredentialRequest) =>
      request<CredentialStatus>(`/api/credentials/${kind}`, { method: 'PUT', body: json(body) }),
    remove: (kind: CredentialKind) => request<void>(`/api/credentials/${kind}`, { method: 'DELETE' }),
    codexDeviceLogin: {
      start: () => request<DeviceLogin>('/api/credentials/codex/device-login', { method: 'POST' }),
      get: (id: string) => request<DeviceLogin>(`/api/credentials/codex/device-login/${id}`),
    },
    githubRepos: (query: string) => request<GitHubReposResponse>(`/api/credentials/github/repos${q({ query })}`),
    githubBranches: (owner: string, repo: string) =>
      request<GitHubBranchesResponse>(`/api/credentials/github/repos/${owner}/${repo}/branches`),
  },
  agents: {
    list: () => request<AgentsResponse>('/api/agents'),
    refresh: (agent?: AgentKind) => request<AgentsResponse>(`/api/agents/refresh${q({ agent })}`, { method: 'POST' }),
  },
  projects: {
    list: () => request<ProjectsResponse>('/api/projects'),
    create: (body: CreateProjectRequest) => request<Project>('/api/projects', { method: 'POST', body: json(body) }),
    get: (id: string) => request<Project>(`/api/projects/${id}`),
    update: (id: string, body: UpdateProjectRequest) =>
      request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: json(body) }),
    remove: (id: string, force = false) =>
      request<void>(`/api/projects/${id}${q({ force: force ? 1 : undefined })}`, { method: 'DELETE' }),
    env: {
      get: (id: string) => request<ProjectEnvResponse>(`/api/projects/${id}/env`),
      put: (id: string, body: PutProjectEnvRequest) =>
        request<ProjectEnvResponse>(`/api/projects/${id}/env`, { method: 'PUT', body: json(body) }),
    },
  },
  threads: {
    list: (archived: boolean) => request<ThreadsResponse>(`/api/threads${q({ archived: archived ? 1 : 0 })}`),
    create: (body: CreateThreadRequest) => request<Thread>('/api/threads', { method: 'POST', body: json(body) }),
    get: (id: string) => request<ThreadListItem>(`/api/threads/${id}`),
    update: (id: string, body: UpdateThreadRequest) =>
      request<ThreadListItem>(`/api/threads/${id}`, { method: 'PATCH', body: json(body) }),
    remove: (id: string) => request<void>(`/api/threads/${id}`, { method: 'DELETE' }),
    send: (id: string, body: SendMessageRequest) =>
      request<SendMessageResponse>(`/api/threads/${id}/messages`, { method: 'POST', body: json(body) }),
    interrupt: (id: string) => request<void>(`/api/threads/${id}/interrupt`, { method: 'POST' }),
    pause: (id: string) => request<Thread>(`/api/threads/${id}/pause`, { method: 'POST' }),
    wake: (id: string) => request<Thread>(`/api/threads/${id}/wake`, { method: 'POST' }),
    archive: (id: string) => request<Thread>(`/api/threads/${id}/archive`, { method: 'POST' }),
    unarchive: (id: string) => request<Thread>(`/api/threads/${id}/unarchive`, { method: 'POST' }),
    permission: (id: string, requestId: string, body: PermissionDecisionRequest) =>
      request<void>(`/api/threads/${id}/permissions/${requestId}`, { method: 'POST', body: json(body) }),
    answer: (id: string, requestId: string, body: QuestionAnswerRequest) =>
      request<void>(`/api/threads/${id}/questions/${requestId}`, { method: 'POST', body: json(body) }),
    events: (id: string, since: number, limit?: number) =>
      request<EventsResponse>(`/api/threads/${id}/events${q({ since, limit })}`),
    changes: (id: string) => request<ChangesResponse>(`/api/threads/${id}/changes`),
    files: (id: string, path: string) => request<FilesResponse>(`/api/threads/${id}/files${q({ path })}`),
    file: (id: string, path: string) => request<FileResponse>(`/api/threads/${id}/file${q({ path })}`),
    portals: (id: string) => request<PortalsResponse>(`/api/threads/${id}/portals`),
    portalAuthUrl: (id: string, port: number, path: string) =>
      request<PortalAuthUrlResponse>(`/api/threads/${id}/portals/${port}/auth${q({ path })}`),
    sharePortal: (id: string, port: number, body: SharePortalRequest) =>
      request<SharePortalResponse>(`/api/threads/${id}/portals/${port}/share`, { method: 'POST', body: json(body) }),
    revokePortalShare: (id: string, port: number) =>
      request<void>(`/api/threads/${id}/portals/${port}/share`, { method: 'DELETE' }),
    services: {
      list: (id: string) => request<ServicesResponse>(`/api/threads/${id}/services`),
      create: (id: string, body: CreateServiceRequest) =>
        request<CreateServiceResponse>(`/api/threads/${id}/services`, { method: 'POST', body: json(body) }),
      action: (id: string, name: string, action: 'start' | 'stop' | 'restart') =>
        request<CreateServiceResponse>(`/api/threads/${id}/services/${encodeURIComponent(name)}/${action}`, { method: 'POST' }),
      remove: (id: string, name: string) => request<void>(`/api/threads/${id}/services/${encodeURIComponent(name)}`, { method: 'DELETE' }),
      logs: (id: string, name: string, lines: number) =>
        request<string>(`/api/threads/${id}/services/${encodeURIComponent(name)}/logs${q({ lines })}`),
    },
    push: (id: string) => request<PushResponse>(`/api/threads/${id}/push`, { method: 'POST' }),
    createPr: (id: string, body: CreatePrRequest) =>
      request<Thread>(`/api/threads/${id}/pr`, { method: 'POST', body: json(body) }),
  },
}

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${path}`
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
