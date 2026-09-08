import { SANDBOX } from '@valet/shared'
import type { SupervisorClient } from '../docker/supervisor-client.js'

const ASKPASS_PATH = `${SANDBOX.home}/.valet/askpass`
const ASKPASS_SCRIPT = '#!/bin/sh\necho "$VALET_GIT_TOKEN"\n'

/**
 * Git reads the password from GIT_ASKPASS. The script itself holds no secret; the
 * token travels only in the environment of the one git process that needs it.
 */
export async function withAskpass<T>(
  supervisor: SupervisorClient,
  token: string | null,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  if (!token) return fn({ GIT_TERMINAL_PROMPT: '0' })
  await supervisor.fsWrite(ASKPASS_PATH, ASKPASS_SCRIPT, '700')
  try {
    return await fn({ GIT_ASKPASS: ASKPASS_PATH, VALET_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' })
  } finally {
    await supervisor.run({ argv: ['rm', '-f', ASKPASS_PATH] }).catch(() => undefined)
  }
}
