'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { LIVE_STATUSES, type Project, type ThreadListItem } from '@valet/shared'
import { api, ApiError, errorMessage } from '@/lib/api'
import { useThreadStream, type StreamState } from '@/lib/stream'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useAppData } from '@/components/app/data-provider'
import { CreatePrDialog } from '@/components/thread/create-pr-dialog'
import { RightPane, type RightPaneTab } from '@/components/thread/right-pane'
import { useThreadActions } from '@/components/thread/thread-actions'
import { ThreadComposer } from '@/components/thread/thread-composer'
import { ThreadHeader } from '@/components/thread/thread-header'
import { TranscriptView } from '@/components/thread/transcript'

export function ThreadView({ id }: { id: string }) {
  const { threads, projects, upsertThread, patchThread } = useAppData()
  const stream = useThreadStream(`/api/threads/${id}/stream`)
  const [missing, setMissing] = useState<string | null>(null)
  const thread = threads.find((t) => t.id === id)

  // The list row is authoritative; fetch it once so a direct load has it before
  // the sidebar finishes loading.
  useEffect(() => {
    setMissing(null)
    api.threads
      .get(id)
      .then(upsertThread)
      .catch((err: unknown) =>
        setMissing(err instanceof ApiError && err.status === 404 ? 'Not found' : errorMessage(err)),
      )
  }, [id, upsertThread])

  useEffect(() => {
    if (stream.thread) patchThread(stream.thread)
  }, [stream.thread, patchThread])

  if (!thread) {
    if (!missing) return null
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-sm">
        <p>{missing}</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/">New thread</Link>
        </Button>
      </div>
    )
  }

  return <ThreadBody thread={thread} project={projects.find((p) => p.id === thread.projectId)} stream={stream} />
}

function ThreadBody({
  thread,
  project,
  stream,
}: {
  thread: ThreadListItem
  project: Project | undefined
  stream: StreamState
}) {
  const { patchThread } = useAppData()
  const actions = useThreadActions(thread, project)
  const [tab, setTab] = useState<RightPaneTab>('changes')

  return (
    <div className="flex h-full flex-col">
      <ThreadHeader
        thread={thread}
        project={project}
        costUsd={stream.transcript.totalCostUsd || thread.costUsd}
        usage={LIVE_STATUSES.includes(thread.status) ? stream.usage : null}
        actions={actions}
        serviceCount={stream.services.length}
        onOpenServices={() => setTab('services')}
      />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="55" minSize="30" className="flex min-w-0 flex-col">
          <TranscriptView
            threadId={thread.id}
            transcript={stream.transcript}
            status={thread.status}
            reconnecting={stream.everConnected && !stream.connected}
            streamError={stream.error}
          />
          <ThreadComposer threadId={thread.id} status={thread.status} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="45" minSize="20" className="min-w-0">
          <RightPane thread={thread} project={project} actions={actions} portals={stream.portals} services={stream.services} tab={tab} onTabChange={setTab} />
        </ResizablePanel>
      </ResizablePanelGroup>
      <CreatePrDialog thread={thread} open={actions.prOpen} onOpenChange={actions.setPrOpen} onCreated={patchThread} />
    </div>
  )
}
