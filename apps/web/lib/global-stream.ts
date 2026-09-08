'use client'

import { useEffect, useRef } from 'react'
import type { GlobalFrame } from '@valet/shared'
import { wsUrl } from './api'

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 15000

/**
 * Subscribes to `/api/stream`. `onFrame` receives every frame; `onReconnect`
 * fires after a dropped connection is restored so the caller can refetch what
 * it missed. Both callbacks are read through a ref, so they may change freely.
 */
export function useGlobalStream(onFrame: (frame: GlobalFrame) => void, onReconnect: () => void): void {
  const frameRef = useRef(onFrame)
  const reconnectRef = useRef(onReconnect)
  frameRef.current = onFrame
  reconnectRef.current = onReconnect

  useEffect(() => {
    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let hadConnection = false
    let closed = false

    const connect = (): void => {
      if (closed) return
      const socket = new WebSocket(wsUrl('/api/stream'))
      ws = socket
      socket.onopen = () => {
        attempt = 0
        if (hadConnection) reconnectRef.current()
        hadConnection = true
      }
      socket.onmessage = (ev) => frameRef.current(JSON.parse(String(ev.data)) as GlobalFrame)
      socket.onclose = () => {
        if (ws !== socket) return
        ws = null
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
  }, [])
}
