import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { spawn as spawnPty, type IPty } from 'node-pty'
import type { WebSocket } from 'ws'
import { execClientFrameSchema, type ExecClientFrame, type ExecServerFrame } from '@valet/shared'
import { childEnv } from './env.js'
import { MiB, rawToBuffer } from './http.js'
import { isSignal, processes, signalName, sleep, terminate } from './process.js'

const STDIO_GRACE_MS = 1_000
/** Outbound bytes queued on the socket before the producing stream is paused. */
const BACKPRESSURE_BYTES = 4 * MiB

type Proc =
  | { kind: 'pipe'; child: ChildProcessByStdio<Writable, Readable, Readable>; pid: number; detach: boolean }
  | { kind: 'pty'; pty: IPty; pid: number; detach: boolean }

type Start = Extract<ExecClientFrame, { t: 'start' }>

/** What both a pipe stream and a pty expose for flow control. */
type Pausable = { pause(): unknown; resume(): unknown }

/** Stop delivering data and let whatever is left flow to nowhere. */
function drain(stream: Readable): void {
  stream.removeAllListeners('data').resume()
}

function streamEnded(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.readableEnded || stream.destroyed) resolve()
    else stream.once('close', () => resolve())
  })
}

export function handleExec(ws: WebSocket): void {
  const running = new Map<string, Proc>()

  const send = (frame: ExecServerFrame, sent?: () => void): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame), sent)
    else sent?.()
  }

  /**
   * Forwards output while pausing the source whenever the socket's send buffer
   * is over the limit, so a slow reader stalls the process instead of growing
   * the heap. Resumes from the send callback once the buffer has drained.
   */
  const relay = (source: Pausable, id: string, t: 'stdout' | 'stderr') => (data: Buffer | string): void => {
    const base64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64')
    send({ t, id, data: base64 }, () => {
      if (ws.bufferedAmount <= BACKPRESSURE_BYTES) source.resume()
    })
    if (ws.bufferedAmount > BACKPRESSURE_BYTES) source.pause()
  }

  const finished = (id: string, code: number | null, signal: string | null): void => {
    if (!running.delete(id)) return
    processes.count -= 1
    send({ t: 'exit', id, code, signal })
  }

  const startPipe = (frame: Start): void => {
    const [file, ...args] = frame.argv as [string, ...string[]]
    const child = spawn(file, args, {
      ...(frame.cwd !== undefined ? { cwd: frame.cwd } : {}),
      env: childEnv(frame.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let spawned = false
    const proc: Proc = { kind: 'pipe', child, pid: -1, detach: frame.detach ?? false }
    running.set(frame.id, proc)

    child.stdin.on('error', () => {})
    child.stdout.on('data', relay(child.stdout, frame.id, 'stdout'))
    child.stderr.on('data', relay(child.stderr, frame.id, 'stderr'))

    child.once('spawn', () => {
      spawned = true
      proc.pid = child.pid ?? -1
      processes.count += 1
      send({ t: 'started', id: frame.id, pid: proc.pid })
    })
    child.once('error', (err) => {
      if (spawned) return
      running.delete(frame.id)
      send({ t: 'error', id: frame.id, message: `spawn failed: ${err.message}` })
    })
    child.once('exit', async (code, signal) => {
      await Promise.race([Promise.all([streamEnded(child.stdout), streamEnded(child.stderr)]), sleep(STDIO_GRACE_MS)])
      drain(child.stdout)
      drain(child.stderr)
      finished(frame.id, code, signal)
    })
  }

  const startPty = (frame: Start, size: { cols: number; rows: number }): void => {
    const [file, ...args] = frame.argv as [string, ...string[]]
    let pty: IPty
    try {
      pty = spawnPty(file, args, {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        ...(frame.cwd !== undefined ? { cwd: frame.cwd } : {}),
        env: childEnv({ TERM: 'xterm-256color', ...frame.env }),
      })
    } catch (err) {
      send({ t: 'error', id: frame.id, message: `spawn failed: ${(err as Error).message}` })
      return
    }
    running.set(frame.id, { kind: 'pty', pty, pid: pty.pid, detach: frame.detach ?? false })
    processes.count += 1
    send({ t: 'started', id: frame.id, pid: pty.pid })
    pty.onData(relay(pty, frame.id, 'stdout'))
    pty.onExit(({ exitCode, signal }) => {
      if (signal) finished(frame.id, null, signalName(signal))
      else finished(frame.id, exitCode, null)
    })
  }

  const handle = (frame: ExecClientFrame): void => {
    if (frame.t === 'start') {
      if (running.has(frame.id)) {
        send({ t: 'error', id: frame.id, message: 'id already in use' })
        return
      }
      if (frame.pty) startPty(frame, frame.pty)
      else startPipe(frame)
      return
    }

    const proc = running.get(frame.id)
    if (!proc) {
      send({ t: 'error', id: frame.id, message: 'no such process' })
      return
    }

    switch (frame.t) {
      case 'stdin': {
        const data = Buffer.from(frame.data, 'base64')
        if (proc.kind === 'pipe') proc.child.stdin.write(data)
        else proc.pty.write(data.toString('utf8'))
        return
      }
      case 'stdin-close': {
        if (proc.kind === 'pipe') proc.child.stdin.end()
        else send({ t: 'error', id: frame.id, message: 'stdin-close is not supported for pty processes' })
        return
      }
      case 'signal': {
        if (!isSignal(frame.signal)) {
          send({ t: 'error', id: frame.id, message: `unknown signal ${frame.signal}` })
          return
        }
        try {
          if (proc.kind === 'pipe') proc.child.kill(frame.signal)
          else proc.pty.kill(frame.signal)
        } catch (err) {
          send({ t: 'error', id: frame.id, message: (err as Error).message })
        }
        return
      }
      case 'resize': {
        if (proc.kind !== 'pty') {
          send({ t: 'error', id: frame.id, message: 'resize requires a pty' })
          return
        }
        // The ioctl throws EBADF once the master fd is closed, shortly before onExit fires.
        try {
          proc.pty.resize(Math.max(1, frame.cols), Math.max(1, frame.rows))
        } catch (err) {
          send({ t: 'error', id: frame.id, message: (err as Error).message })
        }
        return
      }
    }
  }

  ws.on('message', (raw) => {
    let json: unknown
    try {
      json = JSON.parse(rawToBuffer(raw).toString('utf8'))
    } catch {
      send({ t: 'error', id: '', message: 'invalid JSON' })
      return
    }
    const parsed = execClientFrameSchema.safeParse(json)
    if (!parsed.success) {
      const id = typeof json === 'object' && json !== null && typeof (json as { id?: unknown }).id === 'string'
        ? (json as { id: string }).id
        : ''
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`).join('; ')
      send({ t: 'error', id, message: `invalid frame: ${detail}` })
      return
    }
    handle(parsed.data)
  })

  ws.once('close', () => {
    for (const proc of running.values()) {
      // Nobody reads anymore: unpause so a detached process is not blocked on a full pipe.
      if (proc.kind === 'pipe') {
        drain(proc.child.stdout)
        drain(proc.child.stderr)
      } else proc.pty.resume()
      if (proc.detach || proc.pid <= 0) continue
      // Both spawn paths make the child a group leader, so -pid reaches its tree.
      terminate(-proc.pid)
    }
  })
}
