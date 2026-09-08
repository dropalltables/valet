'use client'

import { useEffect, useRef, useState } from 'react'
import { emptyTranscript, reduceEvent, type Portal, type StreamFrame, type Thread, type Transcript } from '@valet/shared'
import { wsUrl } from './api'

export type StreamState = {
  transcript: Transcript
  /** Thread row pushed by core; null until the first `thread` frame. */
  thread: Thread | null
  /** Listening ports in the sandbox; replaced whole on every `portals` frame. */
  portals: Portal[]
  /** Replay finished; events now arrive as they happen. */
  live: boolean
  connected: boolean
  /** A connection was open at least once; distinguishes reconnecting from connecting. */
  everConnected: boolean
  error: string | null
}

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 15000

function initial(): StreamState {
  return { transcript: emptyTranscript(), thread: null, portals: [], live: false, connected: false, everConnected: false, error: null }
}

/**
 * Keeps one WebSocket to `/api/threads/:id/stream` open for the lifetime of the
 * component, reconnecting with `since` set to the last applied `seq` so replay
 * never duplicates events.
 */
export function useThreadStream(threadId: string): StreamState {
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
      const socket = new WebSocket(wsUrl(`/api/threads/${threadId}/stream?since=${seqRef.current}`))
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
            setState((s) => ({ ...s, thread: frame.thread }))
            return
          case 'portals':
            setState((s) => ({ ...s, portals: frame.portals }))
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
  }, [threadId])

  return state
}
