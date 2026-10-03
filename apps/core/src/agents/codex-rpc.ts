import type { AgentProcess } from '@valet/shared'
import { logger } from '../logger.js'
import type * as P from './codex-types.js'

const log = logger('codex')

export const CODEX_REQUEST_TIMEOUT_MS = 60_000

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/**
 * JSON-RPC framing over a `codex app-server` process: newline-delimited objects
 * without a `jsonrpc` field. Client requests get numeric ids; server requests and
 * notifications go to `onServerMessage`. Shared by the thread adapter and the
 * one-shot model list fetch.
 */
export class CodexRpc {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(
    private readonly proc: AgentProcess,
    private readonly onServerMessage: (msg: P.RpcRequest | P.RpcNotification) => void,
  ) {
    proc.onStdoutLine((line) => this.onLine(line))
  }

  private async write(msg: P.RpcMessage): Promise<void> {
    await this.proc.write(`${JSON.stringify(msg)}\n`)
  }

  request(method: string, params: unknown, timeoutMs = CODEX_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex ${method}: no response within ${Math.ceil(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.write({ id, method, params }).catch((err: unknown) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.write({ method, params })
  }

  respond(id: P.RequestId, result: unknown): void {
    void this.write({ id, result }).catch((err: unknown) => log.warn('failed to answer server request', { err }))
  }

  respondError(id: P.RequestId, message: string): void {
    void this.write({ id, error: { code: -32000, message } }).catch((err: unknown) =>
      log.warn('failed to answer server request', { err }),
    )
  }

  /** Rejects every outstanding request; call once the process is gone. */
  dispose(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private onLine(raw: string): void {
    if (!raw.trim()) return
    let msg: P.RpcMessage
    try {
      msg = JSON.parse(raw) as P.RpcMessage
    } catch {
      log.debug('non-JSON stdout line', { line: raw.slice(0, 200) })
      return
    }
    try {
      if ('id' in msg && msg.id !== undefined && msg.id !== null) {
        if ('method' in msg) this.onServerMessage(msg as P.RpcRequest)
        else this.onResponse(msg as P.RpcResponse)
      } else if ('method' in msg) {
        this.onServerMessage(msg as P.RpcNotification)
      }
    } catch (err) {
      log.error('failed to handle message', { err, method: (msg as P.RpcRequest).method })
    }
  }

  private onResponse(msg: P.RpcResponse): void {
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (msg.error) pending.reject(new Error(`codex ${pending.method}: ${msg.error.message}`))
    else pending.resolve(msg.result)
  }
}
