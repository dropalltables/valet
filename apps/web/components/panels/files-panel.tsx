'use client'

import { Fragment, useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTheme } from 'next-themes'
import { LIVE_STATUSES, formatBytes, type FileEntry, type ThreadListItem } from '@valet/shared'
import { FileIcon, FolderIcon, XIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { highlight } from '@/lib/highlight'
import { Button } from '@/components/ui/button'
import { PaneState } from '@/components/panels/pane-state'
import type { ThreadActions } from '@/components/thread/thread-actions'

export function FilesPanel({ thread, actions }: { thread: ThreadListItem; actions: ThreadActions }) {
  const live = LIVE_STATUSES.includes(thread.status)
  const [dir, setDir] = useState('')
  const [file, setFile] = useState<string | null>(null)

  if (!live) return <PaneState status={thread.status} onWake={actions.wake} waking={actions.busy === 'wake'} />

  const shownPath = file ?? dir
  const segments = shownPath.split('/').filter(Boolean)

  return (
    <div className="flex h-full flex-col">
      <nav aria-label="Path" className="flex items-center gap-1 border-b px-3 py-2 font-mono text-xs">
        <button type="button" className="hover:underline" onClick={() => (setDir(''), setFile(null))}>
          /
        </button>
        {segments.map((seg, i) => {
          const path = segments.slice(0, i + 1).join('/')
          const last = i === segments.length - 1
          return (
            <Fragment key={path}>
              {i > 0 && <span className="text-muted-foreground">/</span>}
              {last && file ? (
                <span>{seg}</span>
              ) : (
                <button type="button" className="hover:underline" onClick={() => (setDir(path), setFile(null))}>
                  {seg}
                </button>
              )}
            </Fragment>
          )
        })}
        <span className="flex-1" />
        {file && (
          <Button size="icon-xs" variant="ghost" aria-label="Close file" onClick={() => setFile(null)}>
            <XIcon />
          </Button>
        )}
      </nav>
      <div className="min-h-0 flex-1 overflow-auto">
        {file ? (
          <FileViewer threadId={thread.id} path={file} />
        ) : (
          <DirectoryList
            threadId={thread.id}
            dir={dir}
            onOpen={(e) => (e.kind === 'dir' ? setDir(e.path) : setFile(e.path))}
          />
        )}
      </div>
    </div>
  )
}

function DirectoryList({
  threadId,
  dir,
  onOpen,
}: {
  threadId: string
  dir: string
  onOpen: (entry: FileEntry) => void
}) {
  const { data, error } = useSWR(['files', threadId, dir], () => api.threads.files(threadId, dir), {
    keepPreviousData: true,
  })
  if (error) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        {error instanceof Error ? error.message : String(error)}
      </p>
    )
  }
  if (!data) return null
  const entries = [...data.entries].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
  )
  if (entries.length === 0) return <p className="p-4 text-sm text-muted-foreground">Empty directory</p>
  return (
    <ul className="py-1">
      {entries.map((e) => (
        <li key={e.path}>
          <button
            type="button"
            onClick={() => onOpen(e)}
            className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent/50"
          >
            {e.kind === 'dir' ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono">{e.name}</span>
            {e.size !== null && e.kind === 'file' && (
              <span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(e.size)}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

function FileViewer({ threadId, path }: { threadId: string; path: string }) {
  const { resolvedTheme } = useTheme()
  const { data, error } = useSWR(['file', threadId, path], () => api.threads.file(threadId, path))
  const [html, setHtml] = useState<string | null>(null)

  // A trailing newline would otherwise render as an empty numbered line.
  const content = data?.content?.replace(/\n$/, '') ?? null

  useEffect(() => {
    setHtml(null)
    if (!content) return
    let cancelled = false
    highlight(content, path, resolvedTheme === 'dark' ? 'dark' : 'light')
      .then((h) => {
        if (!cancelled) setHtml(h)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [content, path, resolvedTheme])

  if (error) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        {error instanceof Error ? error.message : String(error)}
      </p>
    )
  }
  if (!data) return null
  if (data.binary) return <p className="p-4 text-sm text-muted-foreground">Binary file, {formatBytes(data.size)}</p>

  return (
    <div className="flex flex-col">
      {html ? (
        <div className="file-view text-xs" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="file-view text-xs">
          <code>
            {(content ?? '').split('\n').map((line, i) => (
              <span key={i} className="line">
                {line}
                {'\n'}
              </span>
            ))}
          </code>
        </pre>
      )}
      {data.truncated && <p className="border-t px-3 py-2 text-xs text-muted-foreground">Truncated, {formatBytes(data.size)} total</p>}
    </div>
  )
}
