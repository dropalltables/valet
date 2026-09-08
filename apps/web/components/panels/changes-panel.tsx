'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { LIVE_STATUSES, type ChangedFile, type ThreadListItem } from '@valet/shared'
import { ChevronRightIcon } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PatchView, type DiffStyle } from '@/components/diff/diff-view'
import { PaneState } from '@/components/panels/pane-state'
import type { ThreadActions } from '@/components/thread/thread-actions'

const STATUS_LETTER: Record<ChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }

export function ChangesPanel({ thread, actions }: { thread: ThreadListItem; actions: ThreadActions }) {
  const live = LIVE_STATUSES.includes(thread.status)
  const running = thread.status === 'running'
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('unified')
  // `running` is part of the key so the turn's final edits and commit are
  // fetched when it ends, not only on the next focus.
  const { data, error } = useSWR(live ? ['changes', thread.id, running] : null, () => api.threads.changes(thread.id), {
    refreshInterval: running ? 5000 : 0,
    revalidateOnFocus: true,
    shouldRetryOnError: false,
    keepPreviousData: true,
  })

  if (!live || (error instanceof ApiError && error.status === 409)) {
    return <PaneState status={live ? 'paused' : thread.status} onWake={actions.wake} waking={actions.busy === 'wake'} />
  }
  if (error) {
    return (
      <div className="p-4 text-sm text-destructive" role="alert">
        {error instanceof Error ? error.message : String(error)}
      </div>
    )
  }
  if (!data) return null

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs">
        <span className="tabular-nums">
          <span className="text-foreground">+{data.stats.additions}</span>{' '}
          <span className="text-muted-foreground">-{data.stats.deletions}</span>
        </span>
        <span className="text-muted-foreground tabular-nums">
          {data.stats.files} {data.stats.files === 1 ? 'file' : 'files'}
        </span>
        {data.dirty && <span className="text-muted-foreground">Uncommitted</span>}
        <span className="flex-1" />
        <div role="radiogroup" aria-label="Diff layout" className="flex rounded-md border p-0.5">
          {(['unified', 'split'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={diffStyle === s}
              onClick={() => setDiffStyle(s)}
              className={cn(
                'rounded-[5px] px-2 py-0.5',
                diffStyle === s ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {s === 'unified' ? 'Unified' : 'Split'}
            </button>
          ))}
        </div>
        <Button size="xs" variant="outline" disabled={!actions.canGit || actions.busy !== null} onClick={() => void actions.push()}>
          Push
        </Button>
        {actions.prBlocked ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>
                <Button size="xs" disabled>
                  Create PR
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{actions.prBlocked}</TooltipContent>
          </Tooltip>
        ) : thread.pr ? null : (
          <Button size="xs" disabled={!actions.canGit || actions.busy !== null} onClick={actions.openPr}>
            Create PR
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.commits.length > 0 && (
          <ol className="flex flex-col border-b px-3 py-2 text-xs">
            {data.commits.map((c) => (
              <li key={c.sha} className="flex items-center gap-2 py-0.5">
                <span className="font-mono text-muted-foreground">{c.sha.slice(0, 7)}</span>
                <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                <span className="shrink-0 text-muted-foreground">{relativeTime(c.at)}</span>
              </li>
            ))}
          </ol>
        )}
        {data.files.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No changes</p>
        ) : (
          <ul className="flex flex-col">
            {data.files.map((f) => (
              <li key={f.path}>
                <FileRow file={f} diffStyle={diffStyle} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function FileRow({ file, diffStyle }: { file: ChangedFile; diffStyle: DiffStyle }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/file border-b">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/50">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/file:rotate-90" />
        <span className="w-3 shrink-0 font-mono text-muted-foreground">{STATUS_LETTER[file.status]}</span>
        <span className="min-w-0 flex-1 truncate font-mono">
          {file.oldPath && <span className="text-muted-foreground">{file.oldPath} → </span>}
          {file.path}
        </span>
        <span className="shrink-0 tabular-nums">
          <span>+{file.additions}</span> <span className="text-muted-foreground">-{file.deletions}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>{open && <PatchView patch={file.patch} diffStyle={diffStyle} />}</CollapsibleContent>
    </Collapsible>
  )
}
