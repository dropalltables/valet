'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import {
  LIVE_STATUSES,
  SANDBOX,
  MANAGED_SERVICE_NAME_RE,
  SHARE_HOURS,
  type CreateManagedServiceRequest,
  type Service,
  type ManagedService,
  type ManagedServiceLogsFrame,
  type ManagedServiceReadiness,
  type ShareHours,
  type ShareServiceResponse,
  type ThreadListItem,
} from '@valet/shared'
import { toast } from 'sonner'
import { api, errorMessage, wsUrl } from '@/lib/api'
import { copy } from '@/lib/clipboard'
import { stripAnsi } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { cn } from '@/lib/utils'
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { PaneState } from '@/components/panels/pane-state'
import type { ThreadActions } from '@/components/thread/thread-actions'

const SHARE_LABELS: Record<ShareHours, string> = { 1: '1 hour', 3: '3 hours', 24: '1 day', 168: '7 days' }

// The iframe is cross-origin, so the browser's own history is inaccessible. Every
// navigation started from the toolbar is recorded here instead.
const IFRAME_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'

const LOG_TAIL_LINES = 200
const LOG_TAIL_STEP = 500
/** Bytes of decoded log text kept in memory per open tail. */
const LOG_BUFFER_LIMIT = 512 * 1024

function stateLabel(s: ManagedService): string {
  const code = s.lastExitCode
  switch (s.state) {
    case 'running':
      return 'Running'
    case 'starting':
      return code === null ? 'Starting' : `Starting (exit ${code})`
    case 'stopped':
      return 'Stopped'
    case 'failed':
      return code === null ? 'Failed' : `Failed (exit ${code})`
    case 'exited':
      return code === null ? 'Exited' : `Exited ${code}`
  }
}

function uptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
}

function describeReadiness(name: string, r: ManagedServiceReadiness, port: number | null): string {
  const where = port === null ? '' : ` on port ${port}`
  switch (r.status) {
    case 'listening':
      return `${name} listening${where}`
    case 'responding':
      return `${name} responding (HTTP ${r.httpStatus ?? '?'})${where}`
    case 'not-responding':
      return `${name} not responding: ${r.error ?? 'unknown'}`
    case 'exited':
      return `${name} ${r.error ?? 'exited'}`
    case 'skipped':
      return `${name} started`
  }
}

/** What the mini-browser and Share need for any row with a port. */
type Target = Service & { title: string }

export function ServicesPanel({
  thread,
  services,
  managed,
  actions,
}: {
  thread: ThreadListItem
  services: Service[]
  managed: ManagedService[]
  actions: ThreadActions
}) {
  const live = LIVE_STATUSES.includes(thread.status)
  const [selectedPort, setSelectedPort] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [detectedOpen, setDetectedOpen] = useState(false)

  if (!live) return <PaneState status={thread.status} onWake={actions.wake} waking={actions.busy === 'wake'} />

  const detected = services.filter((p) => !managed.some((s) => s.port === p.port))
  const targets: Target[] = [
    ...managed.flatMap((s): Target[] => {
      if (s.port === null || s.url === null) return []
      const service = services.find((p) => p.port === s.port)
      return [{ port: s.port, name: s.name, process: null, url: s.url, shareExpiresAt: service?.shareExpiresAt ?? null, title: s.browser === false ? s.name : s.browser.title }]
    }),
    ...detected.map((p): Target => ({ ...p, title: p.name ?? p.process ?? `Port ${p.port}` })),
  ]
  const selected = targets.find((t) => t.port === selectedPort) ?? null
  const empty = managed.length === 0 && detected.length === 0

  return (
    <div className="flex h-full flex-col">
      <div className={cn('flex flex-col overflow-y-auto border-b', selected ? 'max-h-1/2 shrink-0' : 'min-h-0 flex-1')}>
        <div className="flex items-center gap-1 px-2 py-1.5">
          <span className="flex-1" />
          <Button size="xs" variant="outline" aria-pressed={adding} onClick={() => setAdding((a) => !a)}>
            Add service
          </Button>
        </div>
        {adding && <AddServiceForm threadId={thread.id} onDone={() => setAdding(false)} />}
        {empty && !adding && <p className="p-4 text-sm text-muted-foreground">No services</p>}
        {managed.length > 0 && (
          <ul className="flex flex-col">
            {managed.map((s) => (
              <ManagedServiceRow
                key={s.name}
                threadId={thread.id}
                service={s}
                target={targets.find((t) => t.port === s.port && s.port !== null) ?? null}
                selected={s.port !== null && s.port === selectedPort}
                onSelect={() => setSelectedPort(s.port)}
              />
            ))}
          </ul>
        )}
        {detected.length > 0 && (
          <Collapsible open={detectedOpen} onOpenChange={setDetectedOpen} className="group/detected">
            <CollapsibleTrigger className="flex w-full items-center gap-1 px-3 pt-3 pb-1 text-left text-xs text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/detected:rotate-90" />
              <span>Detected</span>
              <span className="tabular-nums">{detected.length}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="flex flex-col">
                {detected.map((p) => (
                  <ServiceRow key={p.port} threadId={thread.id} service={p} selected={p.port === selectedPort} onSelect={() => setSelectedPort(p.port)} />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      {selected && <MiniBrowser key={selected.port} threadId={thread.id} service={selected} />}
    </div>
  )
}

function ServiceActions({ threadId, target }: { threadId: string; target: Target }) {
  return (
    <>
      <Button asChild size="xs" variant="ghost">
        <a href={target.url} target="_blank" rel="noreferrer">
          Open
        </a>
      </Button>
      <Button size="xs" variant="ghost" onClick={() => void copy(target.url)}>
        Copy URL
      </Button>
      <SharePopover threadId={threadId} service={target} />
    </>
  )
}

function ManagedServiceRow({
  threadId,
  service,
  target,
  selected,
  onSelect,
}: {
  threadId: string
  service: ManagedService
  target: Target | null
  selected: boolean
  onSelect: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [logsOpen, setLogsOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const alive = service.state === 'running' || service.state === 'starting'

  async function run(action: 'start' | 'stop' | 'restart'): Promise<void> {
    setBusy(action)
    try {
      const { service: after, readiness } = await api.threads.managedServices.action(threadId, service.name, action)
      if (action === 'stop') return
      const message = describeReadiness(after.name, readiness, after.port)
      if (readiness.ok) toast.success(message)
      else toast.error(message)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  async function remove(): Promise<void> {
    setBusy('remove')
    try {
      await api.threads.managedServices.remove(threadId, service.name)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
      setConfirmRemove(false)
    }
  }

  const Name = target ? 'button' : 'div'

  const running = service.state === 'running' && service.uptimeSeconds !== null

  return (
    <li className={cn('flex flex-col border-b px-2 py-1 text-xs', selected && 'bg-accent/50')}>
      <div className="flex items-center gap-1">
        <Name
          {...(target ? { type: 'button' as const, onClick: onSelect, 'aria-pressed': selected } : {})}
          className={cn('flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5 text-left', target && 'hover:text-foreground')}
        >
          <span className="min-w-0 truncate font-medium">{service.name}</span>
          <span className={cn('shrink-0', service.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
            {stateLabel(service)}
          </span>
          {service.port !== null && <span className="shrink-0 text-muted-foreground tabular-nums">{service.port}</span>}
        </Name>
        {alive ? (
          <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void run('stop')}>
            Stop
          </Button>
        ) : (
          <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void run('start')}>
            Start
          </Button>
        )}
        <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void run('restart')}>
          Restart
        </Button>
        <Button size="xs" variant="ghost" aria-pressed={logsOpen} onClick={() => setLogsOpen((o) => !o)}>
          Logs
        </Button>
        <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
          Remove
        </Button>
      </div>
      {(target || running) && (
        <div className="flex items-center gap-1 pl-1">
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{service.url}</span>
          {running && (
            <span className="shrink-0 text-muted-foreground tabular-nums">
              up {uptime(service.uptimeSeconds ?? 0)}, {service.restarts} {service.restarts === 1 ? 'restart' : 'restarts'}
            </span>
          )}
          {target && <ServiceActions threadId={threadId} target={target} />}
        </div>
      )}
      {logsOpen && <ServiceLogs threadId={threadId} name={service.name} />}
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove service</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-1">
              <span>{service.name}</span>
              <span className="font-mono text-xs">{service.command}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy !== null} onClick={() => void remove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

/**
 * Live tail over the relay socket. `lines` is how far back the tail starts; Show
 * more reopens the socket further back, since the log is a file the supervisor
 * tails, not a buffer core holds. Following pins the view to the newest output.
 */
function ServiceLogs({ threadId, name }: { threadId: string; name: string }) {
  const [lines, setLines] = useState(LOG_TAIL_LINES)
  const [text, setText] = useState('')
  const [following, setFollowing] = useState(true)
  const [closed, setClosed] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  useNow(1000)

  useEffect(() => {
    setText('')
    setClosed(false)
    const decoder = new TextDecoder()
    const ws = new WebSocket(wsUrl(`/api/threads/${threadId}/managed-services/${encodeURIComponent(name)}/logs?lines=${lines}`))
    ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as ManagedServiceLogsFrame
      if (frame.t !== 'data') return
      const chunk = decoder.decode(Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0)), { stream: true })
      setText((t) => {
        const next = t + chunk
        if (next.length <= LOG_BUFFER_LIMIT) return next
        const cut = next.indexOf('\n', next.length - LOG_BUFFER_LIMIT)
        return cut === -1 ? next.slice(-LOG_BUFFER_LIMIT) : next.slice(cut + 1)
      })
    }
    ws.onclose = () => setClosed(true)
    ws.onerror = () => ws.close()
    return () => {
      // A socket closed by this cleanup (re-render, strict-mode double mount) is not a disconnect.
      ws.onclose = null
      ws.close()
    }
  }, [threadId, name, lines])

  useEffect(() => {
    const pre = preRef.current
    if (pre && following) pre.scrollTop = pre.scrollHeight
  }, [text, following])

  return (
    <div className="flex flex-col border-t">
      <div className="flex items-center gap-1 px-2 py-1 text-xs">
        <span className="text-muted-foreground">
          {closed ? 'Disconnected' : `Last ${lines} lines`}
        </span>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={() => setLines((n) => n + LOG_TAIL_STEP)}>
          Show more
        </Button>
        <Button size="xs" variant="ghost" aria-pressed={following} onClick={() => setFollowing((f) => !f)}>
          {following ? 'Stop following' : 'Follow'}
        </Button>
      </div>
      <pre ref={preRef} className="max-h-64 overflow-auto px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre-wrap break-all">
        {stripAnsi(text)}
      </pre>
    </div>
  )
}

function AddServiceForm({ threadId, onDone }: { threadId: string; onDone: () => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState<string>(SANDBOX.repo)
  const [port, setPort] = useState('')
  const [browser, setBrowser] = useState(true)
  const [health, setHealth] = useState('')
  const [busy, setBusy] = useState(false)
  const nameOk = MANAGED_SERVICE_NAME_RE.test(name)
  const portNumber = port.trim() === '' ? undefined : Number(port)
  const portOk = portNumber === undefined || (Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535)
  const healthOk = health.trim() === '' || health.trim().startsWith('/')
  const valid = nameOk && command.trim() !== '' && portOk && healthOk

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!valid) return
    const body: CreateManagedServiceRequest = { name, command: command.trim(), browser }
    if (cwd.trim() && cwd.trim() !== SANDBOX.repo) body.cwd = cwd.trim()
    if (portNumber !== undefined) body.port = portNumber
    if (health.trim()) body.health = health.trim()
    setBusy(true)
    try {
      const { service, readiness } = await api.threads.managedServices.create(threadId, body)
      const message = describeReadiness(service.name, readiness, service.port)
      if (readiness.ok) toast.success(message)
      else toast.error(message)
      onDone()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 border-b px-3 py-2 text-xs">
      <Label htmlFor="svc-name">Name</Label>
      <Input id="svc-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={name !== '' && !nameOk} className="h-7 font-mono text-xs md:text-xs" />
      <Label htmlFor="svc-command">Command</Label>
      <Input id="svc-command" value={command} onChange={(e) => setCommand(e.target.value)} className="h-7 font-mono text-xs md:text-xs" />
      <Label htmlFor="svc-cwd">Directory</Label>
      <Input id="svc-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} className="h-7 font-mono text-xs md:text-xs" />
      <Label htmlFor="svc-port">Port</Label>
      <Input id="svc-port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" aria-invalid={!portOk} className="h-7 w-28 font-mono text-xs md:text-xs" />
      <Label htmlFor="svc-browser">Browser</Label>
      <Switch id="svc-browser" size="sm" checked={browser} onCheckedChange={setBrowser} />
      <Label htmlFor="svc-health">Health path</Label>
      <Input id="svc-health" value={health} onChange={(e) => setHealth(e.target.value)} aria-invalid={!healthOk} className="h-7 font-mono text-xs md:text-xs" />
      <div className="col-span-2 flex justify-end gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={!valid || busy}>
          {busy ? 'Starting' : 'Start'}
        </Button>
      </div>
    </form>
  )
}

function ServiceRow({ threadId, service, selected, onSelect }: { threadId: string; service: Service; selected: boolean; onSelect: () => void }) {
  const target: Target = { ...service, title: service.name ?? service.process ?? `Port ${service.port}` }
  return (
    <li className={cn('flex items-center gap-1 border-b px-2 py-1 text-xs', selected && 'bg-accent/50')}>
      <button type="button" onClick={onSelect} aria-pressed={selected} className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5 text-left hover:text-foreground">
        <span className="min-w-0 truncate font-medium">{target.title}</span>
        {(service.name ?? service.process) && <span className="shrink-0 text-muted-foreground tabular-nums">{service.port}</span>}
        <span className="min-w-0 shrink-[2] truncate font-mono text-muted-foreground">{service.url}</span>
      </button>
      <ServiceActions threadId={threadId} target={target} />
    </li>
  )
}

function SharePopover({ threadId, service }: { threadId: string; service: Service }) {
  const [link, setLink] = useState<ShareServiceResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const expiresAt = link?.expiresAt ?? service.shareExpiresAt

  async function share(hours: ShareHours): Promise<void> {
    setBusy(true)
    try {
      setLink(await api.threads.shareService(threadId, service.port, { hours }))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(): Promise<void> {
    setBusy(true)
    try {
      await api.threads.revokeServiceShare(threadId, service.port)
      setLink(null)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant="ghost">
          Share
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-xs">
        <div className="flex flex-wrap gap-1">
          {SHARE_HOURS.map((h) => (
            <Button key={h} size="xs" variant="outline" disabled={busy} onClick={() => void share(h)}>
              {SHARE_LABELS[h]}
            </Button>
          ))}
        </div>
        {link && (
          <div className="flex items-center gap-1">
            <Input readOnly value={link.url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} className="h-7 font-mono text-xs md:text-xs" />
            <Button size="xs" variant="outline" onClick={() => void copy(link.url)}>
              Copy
            </Button>
          </div>
        )}
        {expiresAt && (
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <span>Shared until {new Date(expiresAt).toLocaleString()}</span>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void revoke()}>
              Revoke
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** A path typed or pasted into the address field; full URLs on this service's origin are reduced to their path. */
function normalizePath(raw: string, origin: string): string {
  let value = raw.trim()
  if (value.startsWith(origin)) value = value.slice(origin.length)
  if (!value.startsWith('/')) value = `/${value}`
  return value
}

function MiniBrowser({ threadId, service }: { threadId: string; service: Target }) {
  const [history, setHistory] = useState<string[]>(['/'])
  const [index, setIndex] = useState(0)
  const [reloads, setReloads] = useState(0)
  const [field, setField] = useState('/')
  const [frame, setFrame] = useState<{ key: string; src: string } | null>(null)
  const path = history[index] ?? '/'

  useEffect(() => setField(path), [path])

  // The frame is a cross-site context, so it cannot reuse the UI session; every
  // load starts from a URL that signs the service host in first. Tokens are short-lived.
  useEffect(() => {
    let cancelled = false
    api.threads
      .serviceAuthUrl(threadId, service.port, path)
      .then(({ url }) => {
        if (!cancelled) setFrame({ key: `${index}:${reloads}`, src: url })
      })
      .catch((err) => toast.error(errorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [threadId, service.port, path, index, reloads])

  function navigate(e: FormEvent): void {
    e.preventDefault()
    const next = normalizePath(field, service.url)
    setHistory((h) => [...h.slice(0, index + 1), next])
    setIndex(index + 1)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5 text-xs">
        <Button size="xs" variant="ghost" disabled={index === 0} onClick={() => setIndex(index - 1)}>
          Back
        </Button>
        <Button size="xs" variant="ghost" disabled={index >= history.length - 1} onClick={() => setIndex(index + 1)}>
          Forward
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setReloads((r) => r + 1)}>
          Reload
        </Button>
        <form onSubmit={navigate} className="min-w-0 flex-1">
          <Input value={field} onChange={(e) => setField(e.target.value)} aria-label="Path" className="h-7 font-mono text-xs md:text-xs" />
        </form>
        <Button asChild size="xs" variant="ghost" className="shrink-0">
          <a href={`${service.url}${path}`} target="_blank" rel="noreferrer">
            Open external
          </a>
        </Button>
      </div>
      {frame && (
        <iframe
          key={frame.key}
          src={frame.src}
          title={service.title}
          sandbox={IFRAME_SANDBOX}
          allow="clipboard-read; clipboard-write"
          className="min-h-0 w-full flex-1 bg-background"
        />
      )}
    </div>
  )
}
