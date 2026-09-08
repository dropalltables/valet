import { constants } from 'node:os'

const SIGNAL_NAMES = new Map<number, string>(
  Object.entries(constants.signals).map(([name, num]) => [num, name]),
)

export function signalName(num: number): string | null {
  return SIGNAL_NAMES.get(num) ?? null
}

export function isSignal(name: string): name is NodeJS.Signals {
  return name in constants.signals
}

/**
 * ESRCH: already gone, which is the outcome we wanted. EPERM: the only members
 * left in the group belong to another uid (root processes spawned through sudo
 * after the valet-owned leader died); nothing more can be done from here.
 */
function signal(target: number, sig: NodeJS.Signals): void {
  try {
    process.kill(target, sig)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ESRCH' && code !== 'EPERM') console.error(`kill ${sig} ${target}: ${code ?? (err as Error).message}`)
  }
}

/**
 * SIGTERM now, SIGKILL in 5 s if anything is left. `target` is a pid, or a
 * negated process group id to take the group down together. Never throws: it
 * runs from timers and close handlers where a throw would take the supervisor down.
 */
export function terminate(target: number): void {
  signal(target, 'SIGTERM')
  setTimeout(() => signal(target, 'SIGKILL'), 5_000).unref()
}

/** Running process count for /health, shared by /run and /exec. */
export const processes = {
  count: 0,
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
