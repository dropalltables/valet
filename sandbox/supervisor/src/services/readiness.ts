import { request } from 'node:http'
import { connect } from 'node:net'
import type { ManagedServiceReadiness } from '@valet/shared'
import { sleep } from '../process.js'

const TOTAL_MS = 60_000
const POLL_MS = 500
const CONNECT_MS = 2_000
const HEALTH_ATTEMPT_MS = 10_000

/** What the readiness loop needs to know about the process between probes. */
export type Liveness = { kind: 'alive' } | { kind: 'exited'; code: number | null }

function tcpConnect(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (error: string | null): void => {
      socket.destroy()
      resolve(error)
    }
    socket.setTimeout(CONNECT_MS, () => done('connect timeout'))
    socket.once('connect', () => done(null))
    socket.once('error', (err) => done((err as NodeJS.ErrnoException).message))
  })
}

/** Resolves with the status, or an error string; never rejects. */
function httpProbe(port: number, path: string): Promise<{ status: number } | { error: string }> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `localhost:${port}` } }, (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0 })
    })
    req.setTimeout(HEALTH_ATTEMPT_MS, () => req.destroy(new Error(`no answer within ${HEALTH_ATTEMPT_MS / 1000} s`)))
    req.once('error', (err) => resolve({ error: err.message }))
    req.end()
  })
}

/**
 * TCP connect every 500 ms, then (with a health path) GET until 2xx/3xx, 60 s in
 * total. Gives up early when the process is gone: waiting out the minute on a
 * unit that already failed only hides the exit code.
 */
export async function waitReady(opts: { port: number | null; health: string | null; liveness: () => Promise<Liveness> }): Promise<ManagedServiceReadiness> {
  if (opts.port === null) return { ok: true, status: 'skipped', httpStatus: null, error: null }
  const port = opts.port
  const deadline = Date.now() + TOTAL_MS
  let lastError = 'not started'
  let lastHttp: number | null = null
  for (;;) {
    const live = await opts.liveness()
    if (live.kind === 'exited') {
      return { ok: false, status: 'exited', httpStatus: null, error: live.code === null ? 'process exited' : `exited with code ${live.code}` }
    }
    const connectError = await tcpConnect(port)
    if (connectError === null) {
      if (opts.health === null) return { ok: true, status: 'listening', httpStatus: null, error: null }
      const probe = await httpProbe(port, opts.health)
      if ('status' in probe) {
        lastHttp = probe.status
        if (probe.status >= 200 && probe.status < 400) return { ok: true, status: 'responding', httpStatus: probe.status, error: null }
        lastError = `HTTP ${probe.status} from ${opts.health}`
      } else lastError = `${opts.health}: ${probe.error}`
    } else lastError = connectError
    if (Date.now() >= deadline) return { ok: false, status: 'not-responding', httpStatus: lastHttp, error: lastError }
    await sleep(POLL_MS)
  }
}
