'use client'

import { useEffect, useRef, useState } from 'react'
import {
  LIVE_STATUSES,
  emptyTranscript,
  reduceEvent,
  type Portal,
  type SandboxUsage,
  type Service,
  type SharedThread,
  type StreamFrame,
  type Thread,
  type Transcript,
} from '@valet/shared'
import { wsUrl } from './api'

export type StreamState = {
  transcript: Transcript
  /** Thread row pushed by core; null until the first `thread` frame. */
  thread: Thread | null
  /** The reduced row an unlisted link gets instead; null on an owner's stream. */
  shared: SharedThread | null
  /** Listening ports in the sandbox; replaced whole on every `portals` frame. */
  portals: Portal[]
  /** Managed services; replaced whole on every `services` frame. */
  services: Service[]
  /** Last resource sample of the running container; null until one arrives. */
  usage: SandboxUsage | null
  /** Replay finished; events now arrive as they happen. */
  live: boolean
  connected: boolean
  /** A connection was open at least once; distinguishes reconnecting from connecting. */
  everConnected: boolean
  error: string | null
}

/** Rows the Services tab shows: managed services plus listening ports no service owns. */
export function serviceRowCount(services: Service[], portals: Portal[]): number {
  return services.length + portals.filter((p) => !services.some((s) => s.port === p.port)).length
}

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 15000

function initial(): StreamState {
  return { transcript: emptyTranscript(), thread: null, shared: null, portals: [], services: [], usage: null, live: false, connected: false, everConnected: false, error: null }
}

/**
 * Keeps one WebSocket to `path` open for the lifetime of the component,
 * reconnecting with `since` set to the last applied `seq` so replay never
 * duplicates events. `path` is `/api/threads/:id/stream` for the owner and
 * `/api/share/:token/stream` for an unlisted link, which carries no portal or
 * service frames.
 */
export function useThreadStream(path: string): StreamState {
  const [state, setState] = useState<StreamState>(initial)
  const seqRef = useRef(0)

  useEffect(() => {
    seqRef.current = 0
    setState(initial())

    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let closed = false

    const connect = (): void => {
      if (closed) return
      const socket = new WebSocket(wsUrl(`${path}?since=${seqRef.current}`))
      ws = socket
      socket.onopen = () => {
        attempt = 0
        setState((s) => ({ ...s, connected: true, everConnected: true, error: null }))
      }
      socket.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data)) as StreamFrame
        switch (frame.t) {
          case 'event': {
            const stored = { seq: frame.seq, event: frame.event }
            setState((s) => {
              const transcript = reduceEvent(s.transcript, stored)
              if (transcript === s.transcript) return s
              seqRef.current = transcript.seq
              return { ...s, transcript }
            })
            return
          }
          case 'live':
            setState((s) => ({ ...s, live: true }))
            return
          case 'thread':
            // A paused sandbox has no usage; keeping the last sample would show it as current after a wake.
            setState((s) => ({ ...s, thread: frame.thread, usage: LIVE_STATUSES.includes(frame.thread.status) ? s.usage : null }))
            return
          case 'thread.shared':
            setState((s) => ({ ...s, shared: frame.thread }))
            return
          case 'portals':
            setState((s) => ({ ...s, portals: frame.portals }))
            return
          case 'services':
            setState((s) => ({ ...s, services: frame.services }))
            return
          case 'usage':
            setState((s) => ({ ...s, usage: frame.usage }))
            return
          case 'error':
            setState((s) => ({ ...s, error: frame.message }))
            return
          default: {
            const _exhaustive: never = frame
            return _exhaustive
          }
        }
      }
      socket.onclose = () => {
        if (ws !== socket) return
        ws = null
        setState((s) => ({ ...s, connected: false, live: false }))
        if (closed) return
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt)
        attempt += 1
        timer = setTimeout(connect, delay)
      }
      socket.onerror = () => socket.close()
    }

    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      ws?.close()
    }
  }, [path])

  return state
}
