import type { ThreadStatus } from '@valet/shared'
import { cn } from '@/lib/utils'
import { STATUS_LABELS } from '@/lib/format'

/**
 * Monochrome status marks. Fill and motion carry the distinction; the word is
 * always present so nothing depends on color.
 */
const DOT: Record<ThreadStatus, string> = {
  provisioning: 'border border-foreground/60 border-dashed animate-spin',
  running: 'bg-foreground animate-pulse',
  waiting: 'border-2 border-foreground',
  idle: 'bg-foreground/50',
  paused: 'border border-foreground/40',
  error: 'bg-destructive',
  archived: 'bg-muted-foreground/30',
}

export function StatusDot({ status, className }: { status: ThreadStatus; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', DOT[status], className)} />
}

export function StatusWord({ status, className }: { status: ThreadStatus; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <StatusDot status={status} />
      {STATUS_LABELS[status]}
    </span>
  )
}
