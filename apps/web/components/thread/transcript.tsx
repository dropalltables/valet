'use client'

import { useEffect, useState } from 'react'
import type { LogLine, ThreadStatus, Transcript } from '@valet/shared'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { TurnView } from '@/components/thread/turn-view'

type Props = {
  /** The thread permissions and questions are answered on; null in a read-only shared view. */
  threadId: string | null
  transcript: Transcript
  status: ThreadStatus
  reconnecting: boolean
  streamError: string | null
}

export function TranscriptView({ threadId, transcript, status, reconnecting, streamError }: Props) {
  return (
    <Conversation className="min-h-0 flex-1">
      <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-6 py-4">
        {transcript.logs.length > 0 && <LogsBlock logs={transcript.logs} status={status} />}
        {transcript.turns.map((turn) => (
          <TurnView key={turn.id} threadId={threadId} turn={turn} />
        ))}
        {(reconnecting || streamError) && (
          <p className="text-xs text-muted-foreground">{streamError ?? 'Reconnecting'}</p>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}

function LogsBlock({ logs, status }: { logs: LogLine[]; status: ThreadStatus }) {
  const attention = status === 'provisioning' || status === 'error'
  const [open, setOpen] = useState(attention)
  useEffect(() => {
    if (attention) setOpen(true)
  }, [attention])
  const errors = logs.filter((l) => l.level === 'error').length

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/logs text-sm">
      <CollapsibleTrigger className="flex items-center gap-2 rounded-md px-1 py-1 text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/logs:rotate-90" />
        <span>Log</span>
        <span className="tabular-nums">{logs.length}</span>
        {errors > 0 && <span className="text-destructive tabular-nums">{errors} errors</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-1 max-h-64 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-5">
          {logs.map((l) => (
            <li
              key={l.seq}
              className={cn(
                'whitespace-pre-wrap break-words',
                l.level === 'warn' && 'text-foreground',
                l.level === 'error' && 'text-destructive',
                l.level === 'info' && 'text-muted-foreground',
              )}
            >
              {l.message}
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  )
}
