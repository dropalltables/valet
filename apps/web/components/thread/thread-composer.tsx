'use client'

import { useState } from 'react'
import { MESSAGEABLE_STATUSES, type ThreadStatus } from '@valet/shared'
import { ImageIcon, SquareIcon } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'
import { Button } from '@/components/ui/button'
import { AttachmentStrip } from '@/components/composer/attachments'
import { DropOverlay } from '@/components/composer/drop-overlay'

type Mode = 'queue' | 'steer'

// The provider owns the draft text, so it survives a failed send (without it the
// form is reset before onSubmit runs) and is dropped when the thread changes.
export function ThreadComposer({ threadId, status }: { threadId: string; status: ThreadStatus }) {
  return (
    <PromptInputProvider key={threadId}>
      <Composer threadId={threadId} status={status} />
    </PromptInputProvider>
  )
}

function Composer({ threadId, status }: { threadId: string; status: ThreadStatus }) {
  const [mode, setMode] = useState<Mode>('queue')
  const [busy, setBusy] = useState(false)
  const running = status === 'running'
  const accepts = MESSAGEABLE_STATUSES.includes(status)
  const effectiveMode: Mode = running ? mode : 'queue'

  async function send(message: PromptInputMessage): Promise<void> {
    const text = message.text.trim()
    if (!text) return
    setBusy(true)
    try {
      await api.threads.send(threadId, {
        text,
        images: message.files
          .filter((f) => f.url.startsWith('data:'))
          .map((f) => ({ mediaType: f.mediaType, dataUrl: f.url })),
        mode: effectiveMode,
      })
    } catch (err) {
      toast.error(errorMessage(err))
      throw err
    } finally {
      setBusy(false)
    }
  }

  async function stop(): Promise<void> {
    try {
      await api.threads.interrupt(threadId)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <div className="border-t px-4 py-3">
      <PromptInput onSubmit={send} accept="image/*" multiple globalDrop className="mx-auto max-w-3xl">
        <DropOverlay />
        <AttachmentStrip />
        <PromptInputTextarea
          disabled={!accepts || busy}
          placeholder={
            effectiveMode === 'steer'
              ? 'Steer the running turn'
              : status === 'paused'
                ? 'Message (wakes the sandbox)'
                : 'Message'
          }
          className="min-h-12"
        />
        <PromptInputFooter>
          <PromptInputTools>
            <AttachButton disabled={!accepts} />
            {running && (
              <div role="radiogroup" aria-label="Send mode" className="flex rounded-md border p-0.5 text-xs">
                {(['queue', 'steer'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    className={cn(
                      'rounded-[5px] px-2 py-0.5',
                      mode === m ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {m === 'queue' ? 'Queue' : 'Steer'}
                  </button>
                ))}
              </div>
            )}
          </PromptInputTools>
          <div className="flex items-center gap-1">
            {running && (
              <Button type="button" size="sm" variant="outline" onClick={() => void stop()}>
                <SquareIcon />
                Stop
              </Button>
            )}
            <PromptInputSubmit disabled={!accepts || busy} aria-label={effectiveMode === 'steer' ? 'Steer' : 'Send'} />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}

function AttachButton({ disabled }: { disabled: boolean }) {
  const attachments = usePromptInputAttachments()
  return (
    <PromptInputButton
      onClick={attachments.openFileDialog}
      disabled={disabled}
      aria-label="Attach image"
      tooltip="Attach image"
    >
      <ImageIcon />
    </PromptInputButton>
  )
}
