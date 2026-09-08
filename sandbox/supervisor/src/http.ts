import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RawData } from 'ws'

export const MiB = 1024 * 1024

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, `body exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.once('end', () => resolve(Buffer.concat(chunks)))
    req.once('error', reject)
  })
}

export function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status)
  res.end()
}

export function rawToBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw)
  return Buffer.from(raw)
}
