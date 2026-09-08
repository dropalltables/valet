'use client'

import { useEffect, useState } from 'react'
import type { ThreadShareResponse } from '@valet/shared'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { copy } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const VISIBILITY = [
  { shared: false, label: 'Private' },
  { shared: true, label: 'Unlisted link' },
] as const

export function SharePopover({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false)
  const [share, setShare] = useState<ThreadShareResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const url = share?.url ?? null

  useEffect(() => {
    if (!open) return
    let cancelled = false
    api.threads.share
      .get(threadId)
      .then((s) => {
        if (!cancelled) setShare(s)
      })
      .catch((err: unknown) => toast.error(errorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [open, threadId])

  async function select(shared: boolean): Promise<void> {
    setBusy(true)
    try {
      if (shared) {
        setShare(await api.threads.share.create(threadId))
      } else {
        await api.threads.share.revoke(threadId)
        setShare({ shared: false, url: null })
      }
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          Share
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-xs">
        <div role="radiogroup" aria-label="Visibility" className="flex rounded-md border p-0.5">
          {VISIBILITY.map((v) => (
            <button
              key={v.label}
              type="button"
              role="radio"
              aria-checked={share?.shared === v.shared}
              disabled={share === null || busy}
              onClick={() => void select(v.shared)}
              className={cn(
                'flex-1 rounded-[5px] px-2 py-0.5',
                share?.shared === v.shared ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
        {url && (
          <>
            <div className="flex items-center gap-1">
              <Input
                readOnly
                value={url}
                aria-label="Share link"
                onFocus={(e) => e.currentTarget.select()}
                className="h-7 font-mono text-xs md:text-xs"
              />
              <Button size="xs" variant="outline" onClick={() => void copy(url)}>
                Copy
              </Button>
            </div>
            <div className="flex justify-end">
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void select(false)}>
                Revoke
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
