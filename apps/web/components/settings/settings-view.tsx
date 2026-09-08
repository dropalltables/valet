'use client'

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  AGENT_LABELS,
  DEFAULT_MODELS,
  MAX_WEBHOOKS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_LABELS,
  WEBHOOK_LABELS,
  type AgentKind,
  type CredentialKind,
  type CredentialStatus,
  type DeviceLogin,
  type NotificationEvent,
  type PermissionPolicy,
  type PutWebhooksRequest,
  type Settings,
  type Webhook,
  type WebhookKind,
} from '@valet/shared'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { useAgents, useCredentials, useNotifications, useSettings } from '@/lib/hooks'
import { disablePush, enablePush, pushStatus, type PushState, type PushStatus } from '@/lib/push'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useHealth } from '@/components/app/health-gate'

export function SettingsView() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-8">
        <h1 className="text-lg font-medium">Settings</h1>
        <Credentials />
        <Sandbox />
        <Defaults />
        <Notifications />
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
  const state = img.pulling !== null ? `Pulling ${img.pulling}%` : img.present ? 'Present' : 'Absent'
  return (
    <Section title="Sandbox">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Image</dt>
        <dd className="font-mono text-xs">{img.image}</dd>
        <dt className="text-muted-foreground">State</dt>
        <dd className="tabular-nums">{state}</dd>
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
        {img.pullError && (
          <>
            <dt className="text-muted-foreground">Pull</dt>
            <dd className="font-mono text-xs text-destructive">{img.pullError}</dd>
          </>
        )}
      </dl>
      {!img.present && img.pulling === null && (
        <p className="font-mono text-xs text-muted-foreground">docker compose --profile sandbox build</p>
      )}
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

const WEBHOOK_URL_PLACEHOLDER: Record<WebhookKind, string> = {
  slack: 'https://hooks.slack.com/services/...',
  discord: 'https://discord.com/api/webhooks/...',
  ntfy: 'https://ntfy.sh/topic',
  generic: 'https://example.com/hook',
}

const PUSH_STATE_WORD: Record<PushState, string> = {
  unsupported: 'Not supported',
  denied: 'Blocked in browser settings',
  off: 'Off',
  on: 'On',
}

type PutWebhook = PutWebhooksRequest['webhooks'][number]

type WebhookDraft = { id: string | null; kind: WebhookKind; url: string; secret: string; events: NotificationEvent[]; hasSecret: boolean }

function Notifications() {
  const { data, mutate } = useNotifications()
  if (!data) return null
  return (
    <Section title="Notifications">
      <BrowserPush vapidPublicKey={data.vapidPublicKey} browsers={data.browsers} onChange={() => void mutate()} />
      <Webhooks
        webhooks={data.webhooks}
        onSave={async (next) => {
          await mutate(await api.notifications.putWebhooks({ webhooks: next }), { revalidate: false })
        }}
      />
    </Section>
  )
}

function BrowserPush({ vapidPublicKey, browsers, onChange }: { vapidPublicKey: string; browsers: number; onChange: () => void }) {
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const read = useCallback(() => {
    void pushStatus().then(setStatus)
  }, [])
  useEffect(read, [read])

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await action()
      onChange()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      read()
      setBusy(false)
    }
  }

  const enable = (): Promise<void> =>
    run(async () => {
      const { subscription, replaced } = await enablePush(vapidPublicKey)
      if (replaced) await api.notifications.unsubscribe({ endpoint: replaced })
      await api.notifications.subscribe(subscription)
    })

  const disable = (): Promise<void> =>
    run(async () => {
      const endpoint = await disablePush()
      if (endpoint) await api.notifications.unsubscribe({ endpoint })
    })

  // Test sends to this browser only, which is the one the state above describes.
  const test = (endpoint: string): Promise<void> =>
    run(async () => {
      const res = await api.notifications.test({ endpoint })
      if (!res.ok) throw new Error(res.error ?? 'Test failed')
    })

  const endpoint = status?.endpoint ?? null

  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <h3 className="font-medium">Browser push</h3>
      {status && <span className="text-xs text-muted-foreground">{PUSH_STATE_WORD[status.state]}</span>}
      {browsers > 0 && <span className="text-xs text-muted-foreground tabular-nums">Browsers: {browsers}</span>}
      {status?.state === 'off' && (
        <Button size="sm" disabled={busy} onClick={() => void enable()}>
          Enable
        </Button>
      )}
      {endpoint && (
        <>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void test(endpoint)}>
            Test
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disable()}>
            Disable
          </Button>
        </>
      )}
    </div>
  )
}

function Webhooks({ webhooks, onSave }: { webhooks: Webhook[]; onSave: (next: PutWebhook[]) => Promise<void> }) {
  const [draft, setDraft] = useState<WebhookDraft | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Webhook | null>(null)
  const [busy, setBusy] = useState(false)

  // Core replaces the whole list, and keeps a stored secret when `secret` is omitted.
  const keep = (w: Webhook): PutWebhook => ({ id: w.id, kind: w.kind, url: w.url, events: w.events })

  async function put(next: PutWebhook[]): Promise<void> {
    setBusy(true)
    try {
      await onSave(next)
      setDraft(null)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!draft) return
    const others = webhooks.filter((w) => w.id !== draft.id).map(keep)
    const entry: PutWebhook = {
      ...(draft.id ? { id: draft.id } : {}),
      kind: draft.kind,
      url: draft.url.trim(),
      events: draft.events,
      ...(draft.kind === 'generic' && draft.secret ? { secret: draft.secret } : {}),
    }
    await put([...others, entry])
  }

  async function test(id: string): Promise<void> {
    setBusy(true)
    try {
      const res = await api.notifications.testWebhook(id)
      if (res.ok) toast.success('Delivered')
      else toast.error(res.error ?? 'Test failed')
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-7 items-center justify-between">
        <h3 className="text-sm font-medium">Webhooks</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={webhooks.length >= MAX_WEBHOOKS}
          onClick={() => setDraft({ id: null, kind: 'slack', url: '', secret: '', events: [...NOTIFICATION_EVENTS], hasSecret: false })}
        >
          Add webhook
        </Button>
      </div>
      {webhooks.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {webhooks.map((w) => (
              <TableRow key={w.id}>
                <TableCell>{WEBHOOK_LABELS[w.kind]}</TableCell>
                <TableCell className="max-w-64 truncate font-mono text-xs text-muted-foreground">{w.url}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {NOTIFICATION_EVENTS.filter((e) => w.events.includes(e))
                    .map((e) => NOTIFICATION_EVENT_LABELS[e])
                    .join(', ')}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Button size="xs" variant="ghost" disabled={busy} onClick={() => void test(w.id)}>
                    Test
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setDraft({ id: w.id, kind: w.kind, url: w.url, secret: '', events: w.events, hasSecret: w.hasSecret })}
                  >
                    Edit
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busy} onClick={() => setPendingDelete(w)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent>
          {draft && (
            <form onSubmit={save} className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>{draft.id ? 'Edit webhook' : 'Add webhook'}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="webhook-kind">Type</Label>
                <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as WebhookKind })}>
                  <SelectTrigger id="webhook-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(WEBHOOK_LABELS) as WebhookKind[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {WEBHOOK_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="webhook-url">URL</Label>
                <Input
                  id="webhook-url"
                  type="url"
                  required
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  placeholder={WEBHOOK_URL_PLACEHOLDER[draft.kind]}
                  className="font-mono"
                  autoFocus
                />
              </div>
              {draft.kind === 'generic' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="webhook-secret">Signing secret</Label>
                  <Input
                    id="webhook-secret"
                    type="password"
                    autoComplete="off"
                    value={draft.secret}
                    onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
                    placeholder={draft.hasSecret ? 'Unchanged' : 'Optional'}
                    className="font-mono"
                  />
                </div>
              )}
              <fieldset className="flex flex-col gap-2">
                <legend className="pb-2 text-sm leading-none font-medium">Events</legend>
                {NOTIFICATION_EVENTS.map((event) => (
                  <div key={event} className="flex items-center gap-2">
                    <Switch
                      id={`webhook-event-${event}`}
                      checked={draft.events.includes(event)}
                      onCheckedChange={(on) =>
                        setDraft({
                          ...draft,
                          events: on ? [...draft.events, event] : draft.events.filter((e) => e !== event),
                        })
                      }
                    />
                    <Label htmlFor={`webhook-event-${event}`}>{NOTIFICATION_EVENT_LABELS[event]}</Label>
                  </div>
                ))}
              </fieldset>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !draft.url.trim() || draft.events.length === 0}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete webhook</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-1">
              <span>{pendingDelete ? WEBHOOK_LABELS[pendingDelete.kind] : ''}</span>
              <span className="font-mono text-xs break-all">{pendingDelete?.url}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const id = pendingDelete?.id
                setPendingDelete(null)
                if (id) void put(webhooks.filter((o) => o.id !== id).map(keep))
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
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
