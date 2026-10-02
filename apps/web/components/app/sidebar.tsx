'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import type { ThreadListItem, ThreadStatus } from '@valet/shared'
import { ChartColumnIcon, FolderIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativeTime, STATUS_LABELS } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/app/status'
import { useAppData } from '@/components/app/data-provider'

type Section = 'active' | 'paused' | 'archived'

const SECTION_OF: Record<ThreadStatus, Section> = {
  provisioning: 'active',
  running: 'active',
  waiting: 'active',
  idle: 'active',
  error: 'active',
  paused: 'paused',
  archived: 'archived',
}

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'paused', label: 'Paused' },
  { id: 'archived', label: 'Archived' },
]

export function Sidebar() {
  const { threads } = useAppData()
  const pathname = usePathname()
  const now = useNow()
  const [section, setSection] = useState<Section>('active')
  const visible = threads.filter((t) => SECTION_OF[t.status] === section)
  const counts = threads.reduce<Record<Section, number>>(
    (acc, t) => {
      acc[SECTION_OF[t.status]] += 1
      return acc
    },
    { active: 0, paused: 0, archived: 0 },
  )

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <Link href="/" className="px-1 text-sm font-medium">
          Valet
        </Link>
        <Button asChild size="sm" variant="ghost">
          <Link href="/">
            <PlusIcon />
            New thread
          </Link>
        </Button>
      </div>
      <div className="flex gap-1 px-3 pb-2" role="tablist">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            role="tab"
            type="button"
            aria-selected={section === s.id}
            onClick={() => setSection(s.id)}
            className={cn(
              'rounded-md px-2 py-1 text-xs',
              section === s.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {s.label}
            {counts[s.id] > 0 && <span className="ml-1 tabular-nums text-muted-foreground">{counts[s.id]}</span>}
          </button>
        ))}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2">
        <ul className="flex flex-col gap-0.5">
          {visible.map((t) => (
            <li key={t.id}>
              <ThreadRow thread={t} active={pathname === `/threads/${t.id}`} now={now} />
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex gap-1 border-t px-3 py-2">
        <Button asChild size="icon-sm" variant={pathname.startsWith('/projects') ? 'secondary' : 'ghost'}>
          <Link href="/projects" aria-label="Projects">
            <FolderIcon />
          </Link>
        </Button>
        <Button asChild size="icon-sm" variant={pathname === '/usage' ? 'secondary' : 'ghost'}>
          <Link href="/usage" aria-label="Usage">
            <ChartColumnIcon />
          </Link>
        </Button>
        <Button asChild size="icon-sm" variant={pathname === '/settings' ? 'secondary' : 'ghost'}>
          <Link href="/settings" aria-label="Settings">
            <SettingsIcon />
          </Link>
        </Button>
      </div>
    </aside>
  )
}

function ThreadRow({ thread, active, now }: { thread: ThreadListItem; active: boolean; now: number }) {
  const stats = thread.diffStats
  // The row link is stretched over the whole row with a pseudo-element so the
  // PR link can sit beside it instead of inside it (nested anchors are invalid).
  return (
    <div
      className={cn(
        'relative flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60',
        active && 'bg-accent',
      )}
    >
      <Link
        href={`/threads/${thread.id}`}
        aria-current={active ? 'page' : undefined}
        className="flex items-center gap-2 after:absolute after:inset-0 after:content-['']"
      >
        <StatusDot status={thread.status} />
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(thread.lastActivityAt, now)}</span>
      </Link>
      <div className="flex items-center gap-2 pl-4 text-xs text-muted-foreground">
        <span className="truncate">{thread.projectName}</span>
        <span className="shrink-0">{STATUS_LABELS[thread.status]}</span>
        <span className="flex-1" />
        {stats && (stats.additions > 0 || stats.deletions > 0) && (
          <span className="shrink-0 tabular-nums">
            +{stats.additions} -{stats.deletions}
          </span>
        )}
        {thread.pr && (
          <a
            href={thread.pr.url}
            target="_blank"
            rel="noreferrer"
            className="relative z-10 shrink-0 tabular-nums underline-offset-2 hover:underline"
          >
            #{thread.pr.number}
          </a>
        )}
      </div>
    </div>
  )
}
