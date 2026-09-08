import { connect } from 'node:net'
import { SANDBOX, type HealthReply } from '@valet/shared'
import { processes } from './process.js'
import pkg from '../package.json' with { type: 'json' }

const PROBE_TIMEOUT_MS = 1_000
const RFB_GREETING = 'RFB 003.008\n'

/**
 * Up means Xvnc answers with the RFB 3.8 greeting. Disconnecting there is safe
 * because Xvnc runs with -UseBlacklist 0; with the blacklist on, five pre-auth
 * disconnects would lock 127.0.0.1 out.
 */
function desktopUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: SANDBOX.vncPort })
    let received = Buffer.alloc(0)
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false))
    socket.once('error', () => done(false))
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      if (received.length < RFB_GREETING.length) return
      done(received.subarray(0, RFB_GREETING.length).toString('latin1') === RFB_GREETING)
    })
  })
}

export async function health(): Promise<HealthReply> {
  return {
    ok: true,
    version: pkg.version,
    uptimeSeconds: Math.floor(process.uptime()),
    desktop: await desktopUp(),
    processes: processes.count,
  }
}
