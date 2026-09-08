'use client'

import { useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { PtyClientFrame, PtyServerFrame } from '@valet/shared'
import { wsUrl } from '@/lib/api'
import { Button } from '@/components/ui/button'
import '@xterm/xterm/css/xterm.css'

const THEMES: Record<'light' | 'dark', ITheme> = {
  light: {
    background: '#ffffff',
    foreground: '#171717',
    cursor: '#171717',
    selectionBackground: '#d4d4d4',
    black: '#171717',
    white: '#e5e5e5',
    brightBlack: '#737373',
    brightWhite: '#fafafa',
  },
  dark: {
    background: '#0a0a0a',
    foreground: '#e5e5e5',
    cursor: '#e5e5e5',
    selectionBackground: '#404040',
    black: '#171717',
    white: '#e5e5e5',
    brightBlack: '#737373',
    brightWhite: '#fafafa',
  },
}

type Connection = 'connecting' | 'open' | 'closed'

const FONT_SIZE = 12

// xterm measures glyphs on a canvas, where `var(--font-geist-mono)` is not a
// valid family, so the variable is resolved to its concrete font list here.
function monoFontFamily(): string {
  const fromVar = getComputedStyle(document.documentElement).getPropertyValue('--font-geist-mono').trim()
  return fromVar || 'ui-monospace, monospace'
}

const encoder = new TextEncoder()

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

export default function TerminalPanel({ threadId }: { threadId: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [generation, setGeneration] = useState(0)
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light'

  // Terminal instance: one per thread, survives reconnects.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const fontFamily = monoFontFamily()
    const term = new Terminal({
      fontFamily,
      fontSize: FONT_SIZE,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: THEMES[theme],
      // tmux reports mouse events (for wheel scrolling), so plain drag goes to tmux;
      // Option-drag still selects text in the browser.
      macOptionClickForcesSelection: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    let disposed = false

    // Fit only on real geometry changes and never while hidden; a fit that
    // changes nothing must be a no-op or the ResizeObserver loops.
    const applyFit = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      const next = fit.proposeDimensions()
      if (!next || !Number.isFinite(next.cols) || !Number.isFinite(next.rows) || next.cols < 2 || next.rows < 2) return
      if (next.cols === term.cols && next.rows === term.rows) return
      fit.fit()
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        const frame: PtyClientFrame = { t: 'resize', cols: term.cols, rows: term.rows }
        ws.send(JSON.stringify(frame))
      }
    }
    let raf = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(applyFit)
    })

    // Cell metrics are measured at open, so the font must be loaded first;
    // output written before then is buffered by xterm.
    void document.fonts
      .load(`${FONT_SIZE}px ${fontFamily}`)
      .catch(() => undefined)
      .then(() => {
        if (disposed) return
        term.open(host)
        try {
          const webgl = new WebglAddon()
          webgl.onContextLoss(() => webgl.dispose())
          term.loadAddon(webgl)
        } catch {
          // DOM renderer stays in place.
        }
        observer.observe(host)
        applyFit()
      })

    const input = term.onData((data) => {
      const ws = wsRef.current
      if (ws?.readyState !== WebSocket.OPEN) return
      const frame: PtyClientFrame = { t: 'data', data: toBase64(encoder.encode(data)) }
      ws.send(JSON.stringify(frame))
    })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      observer.disconnect()
      input.dispose()
      term.dispose()
      termRef.current = null
    }
    // Theme changes are applied through term.options below, not by recreating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = THEMES[theme]
  }, [theme])

  // Socket: recreated on reconnect (generation) and thread change.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    setConnection('connecting')
    const ws = new WebSocket(wsUrl(`/api/threads/${threadId}/pty`))
    wsRef.current = ws
    ws.onopen = () => {
      setConnection('open')
      const frame: PtyClientFrame = { t: 'resize', cols: term.cols, rows: term.rows }
      ws.send(JSON.stringify(frame))
    }
    ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as PtyServerFrame
      if (frame.t === 'data') term.write(fromBase64(frame.data))
      else term.write(`\r\n\u001b[2m[exit ${frame.code}]\u001b[0m\r\n`)
    }
    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null
        setConnection('closed')
      }
    }
    ws.onerror = () => ws.close()
    return () => {
      if (wsRef.current === ws) wsRef.current = null
      ws.close()
    }
  }, [threadId, generation])

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: THEMES[theme].background }}>
      <div ref={hostRef} className="h-full w-full p-2 [&_.xterm]:h-full" />
      {connection === 'closed' && (
        <div className="absolute inset-x-0 bottom-3 flex justify-center">
          <Button size="sm" variant="outline" onClick={() => setGeneration((g) => g + 1)}>
            Reconnect
          </Button>
        </div>
      )}
    </div>
  )
}
