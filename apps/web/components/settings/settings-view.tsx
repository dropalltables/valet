'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  AGENT_LABELS,
  DEFAULT_MODELS,
  type AgentKind,
  type CredentialKind,
  type CredentialStatus,
  type DeviceLogin,
  type PermissionPolicy,
  type Settings,
} from '@valet/shared'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { bytes, relativeTime } from '@/lib/format'
import { useAgents, useCredentials, useSettings, useSnapshots } from '@/lib/hooks'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useHealth } from '@/components/app/health-gate'

export function SettingsView() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-8">
        <h1 className="text-lg font-medium">Settings</h1>
        <Credentials />
        <Sandbox />
        <Snapshots />
        <Defaults />
        <System />
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  )
}

const METHOD_LABEL: Record<'oauth' | 'api-key', string> = { oauth: 'Subscription', 'api-key': 'API key' }

function Credentials() {
  const { data, mutate } = useCredentials()
  const { mutate: mutateAgents } = useAgents()
  const byKind = new Map<CredentialKind, CredentialStatus>((data ?? []).map((c) => [c.kind, c]))
  if (!data) return null
  const changed = (): void => {
    void mutate()
    void mutateAgents()
  }

  return (
    <Section title="Credentials">
      <div className="flex flex-col gap-8">
        <CredentialRow
          kind="claude"
          title="Claude Code"
          status={byKind.get('claude')}
          fields={[{ key: 'token', label: 'Token', placeholder: 'sk-ant-oat... or sk-ant-api...' }]}
          models={<ModelsLine agent="claude" configured={byKind.get('claude')?.configured ?? false} />}
          onChange={changed}
        />
        <CredentialRow
          kind="codex"
          title="Codex"
          status={byKind.get('codex')}
          fields={[{ key: 'apiKey', label: 'API key', placeholder: 'sk-...' }]}
          models={<ModelsLine agent="codex" configured={byKind.get('codex')?.configured ?? false} />}
          extra={<CodexDeviceLogin onComplete={changed} />}
          onChange={changed}
        />
        <CredentialRow
          kind="github"
          title="GitHub"
          status={byKind.get('github')}
          fields={[{ key: 'token', label: 'Personal access token', placeholder: 'ghp_... or github_pat_...' }]}
          onChange={() => void mutate()}
        />
      </div>
    </Section>
  )
}

type Field = { key: 'token' | 'apiKey'; label: string; placeholder: string }

function CredentialRow({
  kind,
  title,
  status,
  fields,
  models,
  extra,
  onChange,
}: {
  kind: CredentialKind
  title: string
  status: CredentialStatus | undefined
  fields: Field[]
  models?: ReactNode
  extra?: ReactNode
  onChange: () => void
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const field = fields[0]!
  const configured = status?.configured ?? false

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!value.trim()) return
    setBusy(true)
    try {
      await api.credentials.put(kind, { [field.key]: value.trim() })
      setValue('')
      onChange()
      toast.success(`${title} saved`)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    setBusy(true)
    try {
      await api.credentials.remove(kind)
      onChange()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <h3 className="font-medium">{title}</h3>
        {configured && status ? (
          <>
            <span className="font-mono text-xs">{status.label}</span>
            {status.method && <span className="text-xs text-muted-foreground">{METHOD_LABEL[status.method]}</span>}
            {status.updatedAt && <span className="text-xs text-muted-foreground">{relativeTime(status.updatedAt)}</span>}
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Not configured</span>
        )}
      </div>
      {models}
      {extra && <div>{extra}</div>}
      <div className="flex flex-wrap items-end gap-3">
        <form onSubmit={save} className="flex flex-1 items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor={`${kind}-${field.key}`}>{field.label}</Label>
            <Input
              id={`${kind}-${field.key}`}
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={field.placeholder}
              className="font-mono"
            />
          </div>
          <Button type="submit" size="default" disabled={busy || !value.trim()}>
            Save
          </Button>
        </form>
      </div>
    </div>
  )
}

/** "Models: N · refreshed <when>" for the agent's catalog, with a Refresh that re-asks the CLI. */
function ModelsLine({ agent, configured }: { agent: AgentKind; configured: boolean }) {
  const { data, mutate } = useAgents()
  const [busy, setBusy] = useState(false)
  const info = data?.agents.find((a) => a.id === agent)
  // Saving a credential starts a refresh in the background; poll until it lands or fails.
  const pending = configured && info?.modelsSource === 'default' && !info.modelsError
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => void mutate(), 5000)
    return () => clearInterval(timer)
  }, [pending, mutate])
  if (!info) return null

  async function refresh(): Promise<void> {
    setBusy(true)
    try {
      await mutate(await api.agents.refresh(agent), { revalidate: false })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const summary =
    info.modelsSource === 'default'
      ? 'Models: defaults'
      : `Models: ${info.models.length}${info.modelsRefreshedAt ? ` · refreshed ${relativeTime(info.modelsRefreshedAt)}` : ''}`
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{summary}</span>
      {info.modelsError && (
        <span role="alert" className="text-destructive">
          {info.modelsError}
        </span>
      )}
      <Button size="xs" variant="ghost" disabled={busy || !configured} onClick={() => void refresh()}>
        {busy ? 'Refreshing' : 'Refresh'}
      </Button>
    </div>
  )
}

function CodexDeviceLogin({ onComplete }: { onComplete: () => void }) {
  const [login, setLogin] = useState<DeviceLogin | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function start(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setLogin(await api.credentials.codexDeviceLogin.start())
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!login || login.status !== 'pending') return
    const timer = setInterval(() => {
      api.credentials.codexDeviceLogin
        .get(login.id)
        .then((next) => {
          setLogin(next)
          if (next.status === 'complete') {
            onComplete()
            toast.success('Codex signed in')
          }
        })
        .catch((err: unknown) => setError(errorMessage(err)))
    }, 3000)
    return () => clearInterval(timer)
  }, [login, onComplete])

  return (
    <>
      <Button type="button" variant="outline" onClick={() => void start()} disabled={busy}>
        Sign in with ChatGPT
      </Button>
      <Dialog open={login !== null} onOpenChange={(o) => !o && setLogin(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign in with ChatGPT</DialogTitle>
          </DialogHeader>
          {login && (
            <div className="flex flex-col gap-4 text-sm">
              <p className="font-mono text-2xl tracking-widest tabular-nums">{login.userCode}</p>
              <a href={login.verificationUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                {login.verificationUrl}
              </a>
              <p className="text-muted-foreground">
                {login.status === 'pending' && 'Waiting'}
                {login.status === 'complete' && 'Signed in'}
                {login.status === 'failed' && (login.error ?? 'Failed')}
                {login.status === 'expired' && 'Code expired'}
              </p>
              {error && (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              )}
              {login.status !== 'pending' && (
                <div>
                  <Button size="sm" onClick={() => setLogin(null)}>
                    Close
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function Sandbox() {
  const { health } = useHealth()
  if (!health) return null
  const img = health.sandboxImage
  return (
    <Section title="Sandbox">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Image</dt>
        <dd className="font-mono text-xs">{img.image}</dd>
        <dt className="text-muted-foreground">State</dt>
        <dd>{img.present ? 'Present' : 'Absent'}</dd>
        {img.imageId && (
          <>
            <dt className="text-muted-foreground">Image id</dt>
            <dd className="font-mono text-xs">{img.imageId.replace(/^sha256:/, '').slice(0, 12)}</dd>
          </>
        )}
        {img.createdAt && (
          <>
            <dt className="text-muted-foreground">Built</dt>
            <dd>{relativeTime(img.createdAt)}</dd>
          </>
        )}
      </dl>
      {!img.present && <p className="font-mono text-xs text-muted-foreground">docker compose --profile sandbox build</p>}
    </Section>
  )
}

function Snapshots() {
  const { data } = useSnapshots()
  if (!data) return null
  return (
    <Section title="Snapshots">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">State</dt>
        <dd>{data.enabled ? 'On' : 'Off'}</dd>
        <dt className="text-muted-foreground">Projects</dt>
        <dd className="tabular-nums">{data.count}</dd>
        <dt className="text-muted-foreground">Storage</dt>
        <dd className="tabular-nums">{`${bytes(data.totalBytes)} of ${bytes(data.budgetBytes)}`}</dd>
      </dl>
    </Section>
  )
}

function Defaults() {
  const { data: settings, mutate } = useSettings()
  const { data: agentsData } = useAgents()
  const [draft, setDraft] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (settings) setDraft(settings)
  }, [settings])

  if (!draft) return null
  const agents = agentsData?.agents ?? []
  const modelsFor = (agent: AgentKind) => {
    const info = agents.find((a) => a.id === agent)
    return info && info.models.length > 0 ? info.models : DEFAULT_MODELS[agent]
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!draft) return
    setBusy(true)
    try {
      await mutate(await api.settings.update(draft), { revalidate: false })
      toast.success('Saved')
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Defaults">
      <form onSubmit={save} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="idle">Idle pause, minutes</Label>
            <Input
              id="idle"
              type="number"
              min={1}
              step={1}
              value={draft.idlePauseMinutes}
              onChange={(e) => setDraft({ ...draft, idlePauseMinutes: Math.max(1, Number(e.target.value) || 1) })}
              className="tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="default-agent">Default agent</Label>
            <Select value={draft.defaultAgent} onValueChange={(v) => setDraft({ ...draft, defaultAgent: v as AgentKind })}>
              <SelectTrigger id="default-agent" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(AGENT_LABELS) as AgentKind[]).map((a) => (
                  <SelectItem key={a} value={a}>
                    {AGENT_LABELS[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(Object.keys(AGENT_LABELS) as AgentKind[]).map((agent) => (
            <div key={agent} className="flex flex-col gap-1.5">
              <Label htmlFor={`model-${agent}`}>{AGENT_LABELS[agent]} model</Label>
              <Select
                value={draft.defaultModel[agent]}
                onValueChange={(v) => setDraft({ ...draft, defaultModel: { ...draft.defaultModel, [agent]: v } })}
              >
                <SelectTrigger id={`model-${agent}`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelsFor(agent).map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="default-permissions">Permissions</Label>
            <Select
              value={draft.defaultPermissions}
              onValueChange={(v) => setDraft({ ...draft, defaultPermissions: v as PermissionPolicy })}
            >
              <SelectTrigger id="default-permissions" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="ask">Ask</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Button type="submit" size="sm" disabled={!dirty || busy}>
            Save
          </Button>
        </div>
      </form>
    </Section>
  )
}

function System() {
  const { health } = useHealth()
  if (!health) return null
  return (
    <Section title="System">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Version</dt>
        <dd className="font-mono text-xs">{health.version}</dd>
        <dt className="text-muted-foreground">Database</dt>
        <dd>{health.db.ok ? 'OK' : health.db.error ?? 'Error'}</dd>
        <dt className="text-muted-foreground">Docker</dt>
        <dd>{health.docker.ok ? 'OK' : health.docker.error ?? 'Error'}</dd>
        <dt className="text-muted-foreground">Password</dt>
        <dd>{health.authEnabled ? 'Required' : 'Off'}</dd>
      </dl>
    </Section>
  )
}
