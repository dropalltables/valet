import { connect, type Socket } from 'node:net'
import type { WebSocket } from 'ws'
import { SANDBOX } from '@valet/shared'
import { rawToBuffer } from './http.js'

const CONNECT_TIMEOUT_MS = 2_000
const BACKPRESSURE_BYTES = 4 * 1024 * 1024

export function connectVnc(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: SANDBOX.vncPort })
    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.once('connect', () => {
      socket.setTimeout(0)
      // Hold the RFB greeting until the websocket handshake is done.
      socket.pause()
      resolve(socket)
    })
    socket.once('timeout', () => socket.destroy(new Error('vnc connect timeout')))
    socket.once('error', reject)
  })
}

export function relayVnc(ws: WebSocket, vnc: Socket): void {
  vnc.removeAllListeners('error')

  vnc.on('data', (chunk: Buffer) => {
    ws.send(chunk, { binary: true }, () => {
      if (ws.bufferedAmount <= BACKPRESSURE_BYTES) vnc.resume()
    })
    if (ws.bufferedAmount > BACKPRESSURE_BYTES) vnc.pause()
  })
  vnc.once('close', () => ws.close())
  vnc.once('error', () => ws.close())

  ws.on('message', (raw) => {
    if (!vnc.write(rawToBuffer(raw))) {
      // ws has no inbound pause; throttling the underlying socket is the lever.
      ws.pause()
      vnc.once('drain', () => ws.resume())
    }
  })
  ws.once('close', () => vnc.destroy())
  ws.once('error', () => vnc.destroy())

  vnc.resume()
}
