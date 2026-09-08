import { existsSync } from 'node:fs'
import { spawn as spawnPty, type IPty } from 'node-pty'
import type { WebSocket } from 'ws'
import { SANDBOX, ptyClientFrameSchema, type SupervisorPtyServerFrame } from '@valet/shared'
import { childEnv } from './env.js'
import { rawToBuffer } from './http.js'

const DEFAULT_SIZE = { cols: 120, rows: 30 }
/** How long to wait for the client's first resize before attaching at the default size. */
const FIRST_FRAME_WAIT_MS = 500
const SESSION = 'main'

/**
 * One tmux client per socket, all attached to the same session. Closing the socket
 * kills the client; the session and whatever runs in it stay.
 */
export function handlePty(ws: WebSocket): void {
  let pty: IPty | null = null
  let closed = false
  const pending: Buffer[] = []

  const send = (frame: SupervisorPtyServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }

  const attach = (size: { cols: number; rows: number }): void => {
    if (pty || closed) return
    const cwd = existsSync(SANDBOX.repo) ? SANDBOX.repo : SANDBOX.home
    pty = spawnPty('tmux', ['new-session', '-A', '-s', SESSION, '-c', cwd], {
      name: 'xterm-256color',
      cols: Math.max(1, size.cols),
      rows: Math.max(1, size.rows),
      cwd,
      env: childEnv({ TERM: 'xterm-256color' }),
    })
    pty.onData((data) => send({ t: 'data', data: Buffer.from(data, 'utf8').toString('base64') }))
    pty.onExit(({ exitCode }) => {
      closed = true
      send({ t: 'exit', code: exitCode })
      ws.close()
    })
    for (const data of pending) pty.write(data.toString('utf8'))
    pending.length = 0
  }

  const timer = setTimeout(() => attach(DEFAULT_SIZE), FIRST_FRAME_WAIT_MS)

  ws.on('message', (raw) => {
    let json: unknown
    try {
      json = JSON.parse(rawToBuffer(raw).toString('utf8'))
    } catch {
      return
    }
    const parsed = ptyClientFrameSchema.safeParse(json)
    if (!parsed.success) return
    const frame = parsed.data

    if (frame.t === 'resize') {
      if (pty) {
        // The ioctl throws EBADF once the master fd is closed, shortly before onExit fires.
        try {
          pty.resize(Math.max(1, frame.cols), Math.max(1, frame.rows))
        } catch {}
      } else {
        clearTimeout(timer)
        attach(frame)
      }
      return
    }
    const data = Buffer.from(frame.data, 'base64')
    if (pty) pty.write(data.toString('utf8'))
    else pending.push(data)
  })

  ws.once('close', () => {
    closed = true
    clearTimeout(timer)
    pty?.kill()
  })
}
