'use client'

import type { ThreadStatus } from '@valet/shared'
import { Button } from '@/components/ui/button'
import { StatusWord } from '@/components/app/status'

/** Shown by every right-pane tab while the sandbox is not running. */
export function PaneState({
  status,
  detail,
  onWake,
  waking,
}: {
  status: ThreadStatus
  detail?: string | null
  /** Null when the viewer cannot wake the sandbox (an unlisted link). */
  onWake: (() => void) | null
  waking: boolean
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
      <StatusWord status={status} className="text-sm" />
      {detail && <p className="max-w-sm text-center text-xs text-muted-foreground">{detail}</p>}
      {status === 'paused' && onWake && (
        <Button size="sm" variant="outline" onClick={onWake} disabled={waking}>
          Wake
        </Button>
      )}
    </div>
  )
}
