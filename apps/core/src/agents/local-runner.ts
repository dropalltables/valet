import { spawn } from 'node:child_process'
import type { AgentProcess, ProcessRunner, SpawnOptions } from '@valet/shared'

/** `node:child_process` runner for development and tests; no container involved. */
export class LocalRunner implements ProcessRunner {
  async spawn(options: SpawnOptions): Promise<AgentProcess> {
    const [file, ...args] = options.argv
    if (!file) throw new Error('argv is empty')
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (err) => reject(err))
    })

    const lineCbs: Array<(line: string) => void> = []
    const stderrCbs: Array<(chunk: string) => void> = []
    let buf: Buffer = Buffer.alloc(0)
    let stdinOpen = true

    const emitLine = (line: string): void => {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line
      for (const cb of lineCbs) cb(clean)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
      let start = 0
      for (;;) {
        const nl = buf.indexOf(0x0a, start)
        if (nl === -1) break
        emitLine(buf.subarray(start, nl).toString('utf8'))
        start = nl + 1
      }
      if (start > 0) buf = buf.subarray(start)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      for (const cb of stderrCbs) cb(text)
    })
    child.stdin.on('error', () => {
      stdinOpen = false
    })

    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('close', (code, signal) => {
        stdinOpen = false
        if (buf.length > 0) {
          emitLine(buf.toString('utf8'))
          buf = Buffer.alloc(0)
        }
        resolve({ code, signal })
      })
    })

    return {
      get pid() {
        return child.pid ?? null
      },
      exited,
      async write(data: string) {
        if (!stdinOpen) throw new Error('stdin is closed')
        await new Promise<void>((resolve, reject) => {
          child.stdin.write(data, (err) => (err ? reject(err) : resolve()))
        })
      },
      async closeStdin() {
        if (!stdinOpen) return
        stdinOpen = false
        child.stdin.end()
      },
      async signal(sig) {
        if (child.exitCode === null && child.signalCode === null) child.kill(sig)
      },
      onStdoutLine(cb) {
        lineCbs.push(cb)
      },
      onStderr(cb) {
        stderrCbs.push(cb)
      },
    }
  }
}
