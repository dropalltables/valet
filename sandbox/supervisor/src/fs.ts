import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fsMkdirRequestSchema, type FsListReply } from '@valet/shared'
import { HttpError, MiB, parseJson, readBody, sendEmpty, sendJson } from './http.js'

const ROOTS = ['/home/valet', '/tmp', '/valet']
const READ_LIMIT = 5 * MiB
const WRITE_LIMIT = 64 * MiB

function within(resolved: string): boolean {
  return ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}/`))
}

/** Real path of `p`, following symlinks in whatever prefix of it exists. */
async function resolveReal(p: string): Promise<string> {
  const missing: string[] = []
  let cur = normalize(p)
  for (;;) {
    try {
      const real = await realpath(cur)
      return missing.length ? join(real, ...missing.reverse()) : real
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = dirname(cur)
      if (parent === cur) throw err
      missing.push(basename(cur))
      cur = parent
    }
  }
}

/** Maps the errno codes a client can cause to statuses; anything else is a 500. */
function fsError(err: unknown): never {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT') throw new HttpError(404, 'not found')
  if (code === 'ENOTDIR') throw new HttpError(400, 'not a directory')
  if (code === 'EISDIR') throw new HttpError(400, 'is a directory')
  if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, 'permission denied')
  throw err
}

async function checkedPath(raw: string | null): Promise<string> {
  if (!raw) throw new HttpError(400, 'path is required')
  if (!isAbsolute(raw)) throw new HttpError(400, 'path must be absolute')
  const resolved = await resolveReal(raw).catch(fsError)
  if (!within(resolved)) throw new HttpError(403, `path is outside ${ROOTS.join(', ')}`)
  return resolved
}

export async function fsList(url: URL, res: ServerResponse): Promise<void> {
  const path = await checkedPath(url.searchParams.get('path'))
  const dirents = await readdir(path, { withFileTypes: true }).catch(fsError)
  const entries = await Promise.all(
    dirents.map(async (d) => {
      const info = await lstat(join(path, d.name)).catch(() => null)
      const kind = d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other'
      return {
        name: d.name,
        kind,
        size: info && kind === 'file' ? info.size : null,
        mtime: info ? info.mtime.toISOString() : null,
      } as const
    }),
  )
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const reply: FsListReply = { path, entries }
  sendJson(res, 200, reply)
}

export async function fsRead(url: URL, res: ServerResponse): Promise<void> {
  const path = await checkedPath(url.searchParams.get('path'))
  const info = await stat(path).catch(fsError)
  if (!info.isFile()) throw new HttpError(400, 'not a file')
  if (info.size > READ_LIMIT) throw new HttpError(413, `file exceeds ${READ_LIMIT} bytes`)
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size })
  await pipeline(createReadStream(path), res)
}

export async function fsWrite(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = await checkedPath(url.searchParams.get('path'))
  const modeParam = url.searchParams.get('mode')
  let mode: number | null = null
  if (modeParam !== null) {
    if (!/^[0-7]{3,4}$/.test(modeParam)) throw new HttpError(400, 'mode must be octal, e.g. 644')
    mode = parseInt(modeParam, 8)
  }
  const body = await readBody(req, WRITE_LIMIT)
  await mkdir(dirname(path), { recursive: true }).catch(fsError)
  await writeFile(path, body).catch(fsError)
  if (mode !== null) await chmod(path, mode).catch(fsError)
  sendEmpty(res, 204)
}

export async function fsMkdir(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = fsMkdirRequestSchema.safeParse(parseJson(await readBody(req, MiB)))
  if (!parsed.success) throw new HttpError(400, 'expected { path }')
  const path = await checkedPath(parsed.data.path)
  await mkdir(path, { recursive: true }).catch(fsError)
  sendEmpty(res, 204)
}
