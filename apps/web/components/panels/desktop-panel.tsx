'use client'

import { useEffect, useRef, useState } from 'react'
import type RFB from '@novnc/novnc'
import { wsUrl } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type Connection = 'connecting' | 'connected' | 'disconnected'

export default function DesktopPanel({ threadId }: { threadId: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [detail, setDetail] = useState<string | null>(null)
  const [viewOnly, setViewOnly] = useState(true)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let rfb: RFB | null = null
    let cancelled = false
    setConnection('connecting')
    setDetail(null)

    // noVNC reads `window` at import time, so it can only load in the browser.
    import('@novnc/novnc').then(({ default: RFBClass }) => {
      if (cancelled) return
      rfb = new RFBClass(host, wsUrl(`/api/threads/${threadId}/vnc`))
      rfb.scaleViewport = true
      rfb.resizeSession = false
      rfb.viewOnly = viewOnly
      rfb.background = 'transparent'
      rfb.addEventListener('connect', () => setConnection('connected'))
      rfb.addEventListener('disconnect', (e: Event) => {
        const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean
        setConnection('disconnected')
        if (clean === false) setDetail('Connection lost')
      })
      rfb.addEventListener('securityfailure', (e: Event) => {
        setDetail((e as CustomEvent<{ reason?: string }>).detail?.reason ?? 'Security failure')
      })
      rfbRef.current = rfb
    })

    return () => {
      cancelled = true
      rfbRef.current = null
      rfb?.disconnect()
    }
    // viewOnly is applied through the setter below; it must not reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, generation])

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly
  }, [viewOnly])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <div role="radiogroup" aria-label="Input" className="flex rounded-md border p-0.5">
          {(
            [
              [true, 'View only'],
              [false, 'Control'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={viewOnly === value}
              onClick={() => setViewOnly(value)}
              className={cn(
                'rounded-[5px] px-2 py-0.5',
                viewOnly === value ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground">
          {connection === 'connecting' ? 'Connecting' : connection === 'connected' ? 'Connected' : 'Disconnected'}
        </span>
        {detail && <span className="text-destructive">{detail}</span>}
        <span className="flex-1" />
        {connection === 'disconnected' && (
          <Button size="xs" variant="outline" onClick={() => setGeneration((g) => g + 1)}>
            Reconnect
          </Button>
        )}
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden bg-muted/30" />
    </div>
  )
}
