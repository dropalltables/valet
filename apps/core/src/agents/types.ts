import type { AdapterStartOptions, ThreadEvent } from '@valet/shared'

export type PromptImage = { mediaType: string; dataUrl: string }

export type AdapterHooks = {
  onEvent(event: ThreadEvent): void
  /** Agent-side session id (Claude session uuid, Codex thread id) as soon as it is known. */
  onSessionId(id: string): void
  /** Live model list when the CLI can report one (Codex `model/list`). */
  onModels?: (models: Array<{ id: string; label: string }>) => void
  /** The CLI process ended on its own (crash, auth failure). The adapter is no longer started. */
  onExit(info: { code: number | null; signal: string | null; duringTurn: boolean }): void
}

/**
 * One adapter per thread; it owns at most one CLI process. `turnId`s are assigned
 * by core and threaded through every event the adapter emits.
 */
export interface Adapter {
  readonly started: boolean
  /** A turn is in flight. */
  readonly busy: boolean
  /** Whether `sendTurn(..., 'steer')` injects into the running turn instead of failing. */
  readonly supportsSteer: boolean
  start(opts: AdapterStartOptions & AdapterHooks): Promise<void>
  sendTurn(turnId: string, prompt: string, images: PromptImage[], mode: 'queue' | 'steer'): Promise<void>
  interrupt(): Promise<void>
  answerPermission(requestId: string, decision: 'allow' | 'deny'): Promise<void>
  answerQuestion(requestId: string, answers: Record<string, string[]>): Promise<void>
  /** Ends the process. Does not emit turn.end for an in-flight turn; the caller does. */
  stop(): Promise<void>
}

/** Strips the data-URL prefix: `data:image/png;base64,AAAA` -> `{ mediaType, base64 }`. */
export function parseDataUrl(dataUrl: string, fallbackMediaType: string): { mediaType: string; base64: string } {
  const m = /^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s.exec(dataUrl)
  if (!m) return { mediaType: fallbackMediaType, base64: dataUrl }
  return { mediaType: m[1] || fallbackMediaType, base64: m[2] ?? '' }
}

export const nowIso = (): string => new Date().toISOString()

export const OUTPUT_LIMIT = 200 * 1024

export function truncateOutput(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text
  return `${text.slice(0, OUTPUT_LIMIT)}\n[valet: output truncated at ${OUTPUT_LIMIT} bytes]`
}
