'use client'

import useSWR from 'swr'
import { AGENT_LABELS } from '@valet/shared'
import { api } from '@/lib/api'
import { useIsMobile } from '@/lib/hooks'
import { useThreadStream } from '@/lib/stream'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusWord } from '@/components/app/status'
import { ChangesPanel } from '@/components/panels/changes-panel'
import { TranscriptView } from '@/components/thread/transcript'

/** An unlisted link: the transcript and the diff, read-only, without a session. */
export function SharedThreadView({ token }: { token: string }) {
  const stream = useThreadStream(`/api/share/${token}/stream`)
  const mobile = useIsMobile()
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

  const transcript = (
    <TranscriptView
      threadId={null}
      transcript={stream.transcript}
      status={status}
      reconnecting={stream.everConnected && !stream.connected}
      streamError={stream.error}
    />
  )
  const changes = <ChangesPanel status={status} source={token} load={() => api.share.changes(token)} actions={null} />

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-1 border-b px-3 py-2 md:px-4">
        <h1 className="truncate text-sm font-medium">{live?.title ?? thread.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <StatusWord status={status} />
          {errorDetail && status === 'error' && <span className="text-destructive">{errorDetail}</span>}
          <span>{thread.projectName}</span>
          <span className="max-w-full truncate font-mono">
            {thread.branch} <span className="text-muted-foreground/60">from</span> {thread.baseBranch}
          </span>
          <span>
            {AGENT_LABELS[thread.agent]} {thread.model}
          </span>
        </div>
      </header>
      {mobile ? (
        <Tabs defaultValue="chat" className="min-h-0 flex-1 gap-0">
          <TabsList variant="line" className="w-full shrink-0 justify-start rounded-none border-b px-2">
            <TabsTrigger value="chat" className="flex-none px-2">
              Chat
            </TabsTrigger>
            <TabsTrigger value="changes" className="flex-none px-2">
              Changes
            </TabsTrigger>
          </TabsList>
          <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
            {transcript}
          </TabsContent>
          <TabsContent value="changes" className="min-h-0 flex-1">
            {changes}
          </TabsContent>
        </Tabs>
      ) : (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="55" minSize="30" className="flex min-w-0 flex-col">
            {transcript}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="45" minSize="20" className="min-w-0">
            {changes}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  )
}
