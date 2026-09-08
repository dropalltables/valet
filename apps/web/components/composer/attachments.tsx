'use client'

import { XIcon } from 'lucide-react'
import { usePromptInputAttachments } from '@/components/ai-elements/prompt-input'

/** Thumbnails for the images attached to the enclosing PromptInput. */
export function AttachmentStrip() {
  const attachments = usePromptInputAttachments()
  if (attachments.files.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-2 px-3 pt-3">
      {attachments.files.map((f) => (
        <li key={f.id} className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={f.url} alt={f.filename ?? 'Attachment'} className="size-16 rounded-md object-cover" />
          <button
            type="button"
            aria-label="Remove attachment"
            onClick={() => attachments.remove(f.id)}
            className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background"
          >
            <XIcon className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  )
}
