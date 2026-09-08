import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { runReplySchema, runRequestSchema, type RunReply, type RunRequest } from '@valet/shared'
import { childEnv } from './env.js'
import { HttpError, MiB } from './http.js'
import { processes, sleep, terminate } from './process.js'

const OUTPUT_LIMIT = 2 * MiB
const DEFAULT_TIMEOUT_MS = 120_000
/** setTimeout silently clamps anything above this to 1 ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1
/** How long after exit to keep reading pipes that a grandchild may still hold. */
const STDIO_GRACE_MS = 1_000
export const RUN_BODY_LIMIT = 16 * MiB

class Capture {
  private readonly chunks: Buffer[] = []
  private size = 0
  private truncated = false

  constructor(stream: Readable) {
    stream.on('data', (chunk: Buffer) => {
      if (this.truncated) return
      if (this.size + chunk.length > OUTPUT_LIMIT) {
        this.chunks.push(chunk.subarray(0, OUTPUT_LIMIT - this.size))
        this.size = OUTPUT_LIMIT
        this.truncated = true
        return
      }
      this.chunks.push(chunk)
      this.size += chunk.length
    })
  }

  text(): string {
    const out = Buffer.concat(this.chunks).toString('utf8')
    return this.truncated ? `${out}\n[valet: output truncated at ${OUTPUT_LIMIT} bytes]` : out
  }
}

function streamEnded(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.readableEnded || stream.destroyed) resolve()
    else stream.once('close', () => resolve())
  })
}

export function parseRunRequest(body: unknown): RunRequest {
  const parsed = runRequestSchema.safeParse(body)
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '))
  const { timeoutMs } = parsed.data
  if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new HttpError(400, `timeoutMs must be an integer in 1..${MAX_TIMEOUT_MS}`)
  }
  return parsed.data
}

export function runToCompletion(request: RunRequest): Promise<RunReply> {
  const [file, ...args] = request.argv
  if (file === undefined) throw new HttpError(400, 'argv is empty')
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    // Own process group so a timeout takes the whole tree down, not just argv[0].
    const child = spawn(file, args, {
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      env: childEnv(request.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    const stdout = new Capture(child.stdout)
    const stderr = new Capture(child.stderr)
    let timedOut = false
    let spawned = false

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) terminate(-child.pid)
    }, timeoutMs)

    child.once('error', (err) => {
      if (spawned) return
      clearTimeout(timer)
      reject(new HttpError(500, `spawn failed: ${err.message}`))
    })

    child.once('spawn', () => {
      spawned = true
      processes.count += 1
      // The process may exit before reading stdin; that is its business.
      child.stdin.on('error', () => {})
      child.stdin.end(request.stdin ?? '')
    })

    child.once('exit', async (code, signal) => {
      clearTimeout(timer)
      processes.count -= 1
      await Promise.race([Promise.all([streamEnded(child.stdout), streamEnded(child.stderr)]), sleep(STDIO_GRACE_MS)])
      // Stop collecting; keep draining so a lingering grandchild is not hit with EPIPE.
      child.stdout.removeAllListeners('data').resume()
      child.stderr.removeAllListeners('data').resume()
      resolve(
        runReplySchema.parse({
          code,
          signal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          timedOut,
        }),
      )
    })
  })
}
