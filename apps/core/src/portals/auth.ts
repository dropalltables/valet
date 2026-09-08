import { eq, sql } from 'drizzle-orm'
import { parseCookie } from '../auth.js'
import { timingSafeEqualStrings, type Cipher } from '../crypto.js'
import type { Db } from '../db/index.js'
import { authState } from '../db/schema.js'

export const PORTAL_COOKIE = 'valet_portal'
const OWNER_COOKIE_MAX_AGE_S = 30 * 24 * 3600
const STATE_ROW_ID = 'default'
export const OWNER_TOKEN_TTL_MS = 60_000

/** Who a portal request comes from: the signed-in user, or someone holding a share link. */
export type PortalGrant = 'owner' | 'guest'
/** What a token confers: `owner` tokens come from a session, `share` tokens from a share link. */
export type TokenScope = 'owner' | 'share'

/**
 * One-time token carried in `/__valet/auth?token=`: AES-GCM over this JSON, so it
 * is both unforgeable and opaque. `g` is the share generation for `share` tokens.
 */
export type PortalToken = {
  v: 1
  t: string
  p: number
  s: TokenScope
  g: number
  /** Epoch ms. */
  exp: number
  /** Same-origin path to land on after the cookie is set. */
  ret: string
}

/**
 * Portal hosts are separate cookie jars, so every host gets its own HMAC-bound
 * cookie. Owner cookies embed a generation that `revokeOwners()` bumps on logout;
 * share cookies embed the per-port share generation.
 */
export class PortalAuth {
  private ownerGeneration = 0

  constructor(
    private readonly cipher: Cipher,
    /** False when VALET_PASSWORD is unset: every portal is open, like the UI. */
    readonly enabled: boolean,
    private readonly db: Db,
  ) {}

  /** Reads the owner generation; must run before the first request. */
  async load(): Promise<void> {
    const [row] = await this.db.select().from(authState).where(eq(authState.id, STATE_ROW_ID))
    this.ownerGeneration = row?.portalOwnerGeneration ?? 0
  }

  /** Every owner cookie issued so far stops working; the next portal visit signs in again through the main host. */
  async revokeOwners(): Promise<void> {
    const [row] = await this.db
      .insert(authState)
      .values({ id: STATE_ROW_ID, portalOwnerGeneration: 1 })
      .onConflictDoUpdate({ target: authState.id, set: { portalOwnerGeneration: sql`${authState.portalOwnerGeneration} + 1` } })
      .returning()
    if (row) this.ownerGeneration = row.portalOwnerGeneration
  }

  mint(token: PortalToken): string {
    return Buffer.from(this.cipher.encryptJson(token), 'base64').toString('base64url')
  }

  /** Null when tampered, malformed, or expired. */
  read(raw: string): PortalToken | null {
    let token: PortalToken
    try {
      token = this.cipher.decryptJson<PortalToken>(Buffer.from(raw, 'base64url').toString('base64'))
    } catch {
      return null
    }
    if (token.v !== 1 || typeof token.t !== 'string' || typeof token.p !== 'number' || typeof token.exp !== 'number') return null
    if ((token.s !== 'owner' && token.s !== 'share') || typeof token.g !== 'number' || typeof token.ret !== 'string') return null
    if (token.exp <= Date.now()) return null
    return token
  }

  private ownerValue(host: string, generation: number): string {
    return `o.${generation}.${this.cipher.hmacHex(`valet-portal-owner-v2:${host.toLowerCase()}:${generation}`)}`
  }

  private shareValue(host: string, generation: number, exp: number): string {
    return `s.${generation}.${exp}.${this.cipher.hmacHex(`valet-portal-share-v1:${host.toLowerCase()}:${generation}:${exp}`)}`
  }

  /** Cookie to set on `host` for a validated token. Share cookies expire with the link. */
  cookie(host: string, token: PortalToken): { value: string; maxAge: number } {
    if (token.s === 'owner') return { value: this.ownerValue(host, this.ownerGeneration), maxAge: OWNER_COOKIE_MAX_AGE_S }
    return { value: this.shareValue(host, token.g, token.exp), maxAge: Math.max(1, Math.ceil((token.exp - Date.now()) / 1000)) }
  }

  /**
   * Who the request's `valet_portal` cookie identifies, or null when it is missing,
   * forged, expired, or from a revoked owner or share generation.
   */
  grant(cookieHeader: string | undefined, host: string, currentGeneration: number): PortalGrant | null {
    if (!this.enabled) return 'owner'
    const value = parseCookie(cookieHeader)[PORTAL_COOKIE]
    if (!value) return null
    const owner = /^o\.(\d+)\./.exec(value)
    if (owner) {
      if (Number(owner[1]) !== this.ownerGeneration) return null
      return timingSafeEqualStrings(value, this.ownerValue(host, this.ownerGeneration)) ? 'owner' : null
    }
    const share = /^s\.(\d+)\.(\d+)\./.exec(value)
    if (!share) return null
    const generation = Number(share[1])
    const exp = Number(share[2])
    if (generation !== currentGeneration || exp <= Date.now()) return null
    return timingSafeEqualStrings(value, this.shareValue(host, generation, exp)) ? 'guest' : null
  }
}
