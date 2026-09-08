'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type KeyboardEvent } from 'react'
import { AGENT_LABELS, type Project, type ThreadListItem } from '@valet/shared'
import { MoreHorizontalIcon } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { usd } from '@/lib/format'
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { StatusWord } from '@/components/app/status'
import { useAppData } from '@/components/app/data-provider'
import type { ThreadActions } from '@/components/thread/thread-actions'

type Props = {
  thread: ThreadListItem
  project: Project | undefined
  costUsd: number | null
  actions: ThreadActions
  serviceCount: number
  onOpenServices: () => void
}

const PR_STATE: Record<'open' | 'merged' | 'closed', string> = { open: 'Open', merged: 'Merged', closed: 'Closed' }

export function ThreadHeader({ thread, project, costUsd, actions, serviceCount, onOpenServices }: Props) {
  const router = useRouter()
  const { upsertThread, removeThread } = useAppData()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const disabled = actions.busy !== null

  async function rename(title: string): Promise<void> {
    if (!title.trim() || title === thread.title) return
    try {
      upsertThread(await api.threads.update(thread.id, { title: title.trim() }))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  async function remove(): Promise<void> {
    setDeleting(true)
    try {
      await api.threads.remove(thread.id)
      removeThread(thread.id)
      router.push('/')
    } catch (err) {
      toast.error(errorMessage(err))
      setDeleting(false)
    }
  }

  const cost = usd(costUsd ?? thread.costUsd)

  return (
    <header className="flex flex-col gap-1 border-b px-4 py-2">
      <div className="flex items-center gap-2">
        <TitleEditor title={thread.title} onRename={rename} />
        <span className="flex-1" />
        {/* Stop lives in the composer; Push and Create PR live in the Changes tab. */}
        {thread.pr && (
          <Button asChild size="sm" variant="secondary">
            <a href={thread.pr.url} target="_blank" rel="noreferrer">
              {PR_STATE[thread.pr.state]} #{thread.pr.number}
            </a>
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="More">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(thread.status === 'idle' || thread.status === 'waiting') && (
              <DropdownMenuItem disabled={disabled} onSelect={actions.pause}>
                Pause
              </DropdownMenuItem>
            )}
            {thread.status === 'paused' && (
              <DropdownMenuItem disabled={disabled} onSelect={actions.wake}>
                Wake
              </DropdownMenuItem>
            )}
            {thread.status === 'archived' ? (
              <DropdownMenuItem onSelect={actions.unarchive}>Unarchive</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={actions.archive}>Archive</DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <StatusWord status={thread.status} />
        {thread.error && thread.status === 'error' && <span className="text-destructive">{thread.error}</span>}
        {project ? (
          <Link href={`/projects/${project.id}`} className="hover:text-foreground">
            {project.name}
          </Link>
        ) : (
          <span>{thread.projectName}</span>
        )}
        <span className="font-mono">
          {thread.branch} <span className="text-muted-foreground/60">from</span> {thread.baseBranch}
        </span>
        <span>
          {AGENT_LABELS[thread.agent]} {thread.model}
        </span>
        <span>{thread.permissions === 'ask' ? 'Ask' : 'Auto'}</span>
        {cost && <span className="tabular-nums">{cost}</span>}
        {thread.mcpServers > 0 && <span className="tabular-nums">{thread.mcpServers} MCP</span>}
        {serviceCount > 0 && (
          <button type="button" onClick={onOpenServices} className="tabular-nums hover:text-foreground">
            {serviceCount} {serviceCount === 1 ? 'service' : 'services'}
          </button>
        )}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete thread</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-1">
              <span>{thread.title}</span>
              <span className="font-mono text-xs">{thread.branch}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void remove()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  )
}

function TitleEditor({ title, onRename }: { title: string; onRename: (title: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)

  function start(): void {
    setValue(title)
    setEditing(true)
  }
  function commit(): void {
    setEditing(false)
    void onRename(value)
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') setEditing(false)
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={onKeyDown}
        aria-label="Thread title"
        className="h-7 max-w-xl text-sm font-medium"
      />
    )
  }
  return (
    <button
      type="button"
      onClick={start}
      className="min-w-0 truncate text-left text-sm font-medium hover:underline"
      aria-label="Rename thread"
    >
      {title}
    </button>
  )
}
