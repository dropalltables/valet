import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ThreadEvent } from '@valet/shared'
import type { AdapterHooks } from '../src/agents/types.js'

/** Writes an executable fake CLI script to a temp dir; caller removes the dir. */
export async function fakeCli(name: string, source: string): Promise<{ dir: string; exe: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'valet-fake-cli-'))
  const exe = path.join(dir, name)
  await fs.writeFile(exe, `#!${process.execPath}\n${source}`, { mode: 0o755 })
  return { dir, exe }
}

export type Recorder = AdapterHooks & {
  events: ThreadEvent[]
  sessionIds: string[]
  exits: Array<{ code: number | null; signal: string | null; duringTurn: boolean }>
  /** Resolves when an event of this type has been recorded. */
  waitFor(type: ThreadEvent['type'], count?: number): Promise<void>
}

export function recorder(): Recorder {
  const events: ThreadEvent[] = []
  const waiters: Array<() => void> = []
  const notify = (): void => {
    for (const w of waiters.splice(0)) w()
  }
  const rec: Recorder = {
    events,
    sessionIds: [],
    exits: [],
    onEvent: (e) => {
      events.push(e)
      notify()
    },
    onSessionId: (id) => {
      rec.sessionIds.push(id)
    },
    onExit: (info) => {
      rec.exits.push(info)
      notify()
    },
    waitFor(type, count = 1) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000)
        const check = (): void => {
          if (events.filter((e) => e.type === type).length >= count) {
            clearTimeout(timer)
            resolve()
          } else waiters.push(check)
        }
        check()
      })
    },
  }
  return rec
}

export const types = (events: ThreadEvent[]): string[] => events.map((e) => e.type)
