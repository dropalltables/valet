import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { childEnv } from './env.js'

const run = promisify(execFile)

/** The one session: the browser terminal attaches to it, the agent is told to open windows in it. */
export const TMUX_SESSION = 'main'

async function hasSession(): Promise<boolean> {
  // `=name` matches exactly; a bare name is a prefix match.
  return run('tmux', ['has-session', '-t', `=${TMUX_SESSION}`], { env: childEnv() }).then(
    () => true,
    () => false,
  )
}

/**
 * Creates the session detached, rooted at `cwd`, unless it exists. Without this the
 * agent's `tmux new-window -t main` fails until a terminal has attached once.
 */
export async function ensureTmuxSession(cwd: string): Promise<void> {
  if (await hasSession()) return
  try {
    await run('tmux', ['new-session', '-d', '-s', TMUX_SESSION, '-c', cwd], { env: childEnv(), cwd })
  } catch (err) {
    // Two spawns racing here: the loser sees "duplicate session".
    if (!(await hasSession())) throw err
  }
}
