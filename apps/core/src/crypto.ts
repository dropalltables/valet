import crypto from 'node:crypto'

const IV_BYTES = 12
const TAG_BYTES = 16

/** AES-256-GCM; output is base64(iv || tag || ciphertext). */
export class Cipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('cipher key must be 32 bytes')
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
  }

  decrypt(payload: string): string {
    const buf = Buffer.from(payload, 'base64')
    if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short')
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, IV_BYTES))
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value))
  }

  decryptJson<T = unknown>(payload: string): T {
    return JSON.parse(this.decrypt(payload)) as T
  }

  hmacHex(message: string): string {
    return crypto.createHmac('sha256', this.key).update(message).digest('hex')
  }
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex')
}
