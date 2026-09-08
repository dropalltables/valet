import { createServer } from 'node:net'

/** Assigned ports: above the ephemeral-range floor Linux does not use for outgoing connections by default. */
export const PORT_RANGE = { min: 30000, max: 32767 } as const

/** Bind-tests the port on every address, so a listener on any interface counts. */
export function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, () => server.close(() => resolve(true)))
  })
}

/** Lowest free port in range that no registered service holds. */
export async function allocatePort(taken: Set<number>): Promise<number> {
  for (let port = PORT_RANGE.min; port <= PORT_RANGE.max; port++) {
    if (taken.has(port)) continue
    if (await isFree(port)) return port
  }
  throw new Error(`no free port in ${PORT_RANGE.min}-${PORT_RANGE.max}`)
}
