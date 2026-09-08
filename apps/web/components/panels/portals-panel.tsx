'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { LIVE_STATUSES, SHARE_HOURS, type Portal, type ShareHours, type SharePortalResponse, type ThreadListItem } from '@valet/shared'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PaneState } from '@/components/panels/pane-state'
import type { ThreadActions } from '@/components/thread/thread-actions'

const SHARE_LABELS: Record<ShareHours, string> = { 1: '1 hour', 3: '3 hours', 24: '1 day', 168: '7 days' }

// The iframe is cross-origin, so the browser's own history is inaccessible. Every
// navigation started from the toolbar is recorded here instead.
const IFRAME_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Copied')
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

export function PortalsPanel({ thread, portals, actions }: { thread: ThreadListItem; portals: Portal[]; actions: ThreadActions }) {
  const live = LIVE_STATUSES.includes(thread.status)
  const [selectedPort, setSelectedPort] = useState<number | null>(null)
  const selected = portals.find((p) => p.port === selectedPort) ?? null

  if (!live) return <PaneState status={thread.status} onWake={actions.wake} waking={actions.busy === 'wake'} />
  if (portals.length === 0) return <p className="p-4 text-sm text-muted-foreground">No portals</p>

  return (
    <div className="flex h-full flex-col">
      <ul className="flex shrink-0 flex-col border-b">
        {portals.map((p) => (
          <PortalRow key={p.port} threadId={thread.id} portal={p} selected={p.port === selectedPort} onSelect={() => setSelectedPort(p.port)} />
        ))}
      </ul>
      {selected && <MiniBrowser key={selected.port} threadId={thread.id} portal={selected} />}
    </div>
  )
}

function PortalRow({ threadId, portal, selected, onSelect }: { threadId: string; portal: Portal; selected: boolean; onSelect: () => void }) {
  return (
    <li className={cn('flex items-center gap-1 px-2 py-1 text-xs', selected && 'bg-accent/50')}>
      <button type="button" onClick={onSelect} aria-pressed={selected} className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5 text-left hover:text-foreground">
        <span className="shrink-0 font-medium">{portal.name ?? portal.process ?? `Port ${portal.port}`}</span>
        {(portal.name ?? portal.process) && <span className="shrink-0 text-muted-foreground tabular-nums">{portal.port}</span>}
        <span className="min-w-0 truncate font-mono text-muted-foreground">{portal.url}</span>
      </button>
      <Button asChild size="xs" variant="ghost">
        <a href={portal.url} target="_blank" rel="noreferrer">
          Open
        </a>
      </Button>
      <Button size="xs" variant="ghost" onClick={() => void copy(portal.url)}>
        Copy URL
      </Button>
      <SharePopover threadId={threadId} portal={portal} />
    </li>
  )
}

function SharePopover({ threadId, portal }: { threadId: string; portal: Portal }) {
  const [link, setLink] = useState<SharePortalResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const expiresAt = link?.expiresAt ?? portal.shareExpiresAt

  async function share(hours: ShareHours): Promise<void> {
    setBusy(true)
    try {
      setLink(await api.threads.sharePortal(threadId, portal.port, { hours }))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(): Promise<void> {
    setBusy(true)
    try {
      await api.threads.revokePortalShare(threadId, portal.port)
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

/** A path typed or pasted into the address field; full URLs on this portal's origin are reduced to their path. */
function normalizePath(raw: string, origin: string): string {
  let value = raw.trim()
  if (value.startsWith(origin)) value = value.slice(origin.length)
  if (!value.startsWith('/')) value = `/${value}`
  return value
}

function MiniBrowser({ threadId, portal }: { threadId: string; portal: Portal }) {
  const [history, setHistory] = useState<string[]>(['/'])
  const [index, setIndex] = useState(0)
  const [reloads, setReloads] = useState(0)
  const [field, setField] = useState('/')
  const [frame, setFrame] = useState<{ key: string; src: string } | null>(null)
  const path = history[index] ?? '/'

  useEffect(() => setField(path), [path])

  // The frame is a cross-site context, so it cannot reuse the UI session; every
  // load starts from a URL that signs the portal host in first. Tokens are short-lived.
  useEffect(() => {
    let cancelled = false
    api.threads
      .portalAuthUrl(threadId, portal.port, path)
      .then(({ url }) => {
        if (!cancelled) setFrame({ key: `${index}:${reloads}`, src: url })
      })
      .catch((err) => toast.error(errorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [threadId, portal.port, path, index, reloads])

  function navigate(e: FormEvent): void {
    e.preventDefault()
    const next = normalizePath(field, portal.url)
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
          <a href={`${portal.url}${path}`} target="_blank" rel="noreferrer">
            Open external
          </a>
        </Button>
      </div>
      {frame && (
        <iframe
          key={frame.key}
          src={frame.src}
          title={`Port ${portal.port}`}
          sandbox={IFRAME_SANDBOX}
          allow="clipboard-read; clipboard-write"
          className="min-h-0 w-full flex-1 bg-background"
        />
      )}
    </div>
  )
}
