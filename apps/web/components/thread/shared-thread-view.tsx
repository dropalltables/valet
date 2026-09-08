'use client'

import useSWR from 'swr'
import { AGENT_LABELS } from '@valet/shared'
import { api } from '@/lib/api'
import { useThreadStream } from '@/lib/stream'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { StatusWord } from '@/components/app/status'
import { ChangesPanel } from '@/components/panels/changes-panel'
import { TranscriptView } from '@/components/thread/transcript'

/** An unlisted link: the transcript and the diff, read-only, without a session. */
export function SharedThreadView({ token }: { token: string }) {
  const stream = useThreadStream(`/api/share/${token}/stream`)
  const { data, error } = useSWR(['share', token], () => api.share.thread(token), { shouldRetryOnError: false })

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm">
        <p>Not found</p>
      </div>
    )
  }
  if (!data) return null

  const thread = data.thread
  const live = stream.shared
  const status = live?.status ?? thread.status
  const errorDetail = live ? live.error : thread.error

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-1 border-b px-4 py-2">
        <h1 className="truncate text-sm font-medium">{live?.title ?? thread.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <StatusWord status={status} />
          {errorDetail && status === 'error' && <span className="text-destructive">{errorDetail}</span>}
          <span>{thread.projectName}</span>
          <span className="font-mono">
            {thread.branch} <span className="text-muted-foreground/60">from</span> {thread.baseBranch}
          </span>
          <span>
            {AGENT_LABELS[thread.agent]} {thread.model}
          </span>
        </div>
      </header>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="55" minSize="30" className="flex min-w-0 flex-col">
          <TranscriptView
            threadId={null}
            transcript={stream.transcript}
            status={status}
            reconnecting={stream.everConnected && !stream.connected}
            streamError={stream.error}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="45" minSize="20" className="min-w-0">
          <ChangesPanel status={status} source={token} load={() => api.share.changes(token)} actions={null} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
