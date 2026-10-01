import { SHARE_PATH, type ChangesResponse, type ThreadShareResponse } from '@valet/shared'
import type { Config } from '../config.js'
import type { Cipher } from '../crypto.js'
import type { ThreadService } from './service.js'

/**
 * The whole credential behind an unlisted link: AES-GCM over this JSON, so it is
 * unforgeable and opaque. `k` keeps it apart from the service tokens the same cipher
 * mints. There is no expiry; `g` is the thread's share generation, which `revoke()`
 * bumps, and a token whose generation is stale is dead.
 */
type ShareToken = { v: 1; k: typeof SHARE_KIND; t: string; g: number }
const SHARE_KIND = 'thread-share'

/** How long one computed diff serves every link holder, matching the panel's poll interval. */
const CHANGES_TTL_MS = 5_000

/** Mints, verifies, and revokes unlisted thread links, and serves what they expose. */
export class ThreadShares {
  /** Live shared streams per thread, so `revoke()` can hang up on the viewers it just cut off. */
  private readonly viewers = new Map<string, Set<() => void>>()
  private readonly recentChanges = new Map<string, { at: number; result: Promise<ChangesResponse> }>()

  constructor(
    private readonly cfg: Config,
    private readonly cipher: Cipher,
    private readonly threads: ThreadService,
  ) {}

  async status(id: string): Promise<ThreadShareResponse> {
    const state = await this.threads.shareState(id)
    return { shared: state.shared, url: state.shared ? this.url(id, state.generation) : null }
  }

  /** Idempotent: re-sharing keeps the generation, so links already handed out stay valid. */
  async create(id: string): Promise<ThreadShareResponse> {
    const state = await this.threads.shareState(id)
    if (!state.shared) await this.threads.setShare(id, { shared: true, generation: state.generation })
    return { shared: true, url: this.url(id, state.generation) }
  }

  /** Bumps the generation: every link issued for the thread so far stops working, open streams included. */
  async revoke(id: string): Promise<void> {
    const state = await this.threads.shareState(id)
    await this.threads.setShare(id, { shared: false, generation: state.generation + 1 })
    for (const close of this.viewers.get(id) ?? []) close()
  }

  /** Registers a live shared stream for `id`; the returned function detaches it. */
  watch(id: string, close: () => void): () => void {
    const set = this.viewers.get(id) ?? new Set<() => void>()
    this.viewers.set(id, set)
    set.add(close)
    return () => {
      set.delete(close)
      if (set.size === 0) this.viewers.delete(id)
    }
  }

  /**
   * The thread's changes for a link holder. Link holders are unauthenticated and
   * poll, and computing this runs git inside the sandbox, so one computation per
   * thread serves every viewer for the length of a poll interval.
   */
  async changes(id: string): Promise<ChangesResponse> {
    const now = Date.now()
    for (const [key, entry] of this.recentChanges) if (now - entry.at >= CHANGES_TTL_MS) this.recentChanges.delete(key)
    const cached = this.recentChanges.get(id)
    if (cached) return cached.result
    const result = this.threads.changes(id)
    this.recentChanges.set(id, { at: now, result })
    // A failure (paused sandbox, git error) must not be served for the rest of the window.
    result.catch(() => this.recentChanges.delete(id))
    return result
  }

  /**
   * The thread a link token names, or null when it is malformed, forged, or revoked.
   * The token is AES-GCM authenticated, so guessing one is infeasible and there is
   * nothing here for a rate limit to defend.
   */
  async resolve(raw: string): Promise<string | null> {
    const token = this.read(raw)
    if (!token) return null
    const state = await this.threads.shareState(token.t).catch(() => null)
    return state?.shared === true && state.generation === token.g ? token.t : null
  }

  private url(id: string, generation: number): string {
    const token = Buffer.from(this.cipher.encryptJson({ v: 1, k: SHARE_KIND, t: id, g: generation } satisfies ShareToken), 'base64').toString('base64url')
    return `${this.cfg.VALET_BASE_URL}${SHARE_PATH}/${token}`
  }

  private read(raw: string): ShareToken | null {
    let token: ShareToken
    try {
      token = this.cipher.decryptJson<ShareToken>(Buffer.from(raw, 'base64url').toString('base64'))
    } catch {
      return null
    }
    if (token.v !== 1 || token.k !== SHARE_KIND) return null
    if (typeof token.t !== 'string' || typeof token.g !== 'number') return null
    return token
  }
}
