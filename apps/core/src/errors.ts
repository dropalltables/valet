export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const notFound = (what: string): HttpError => new HttpError(404, `${what} not found`)
export const badRequest = (message: string): HttpError => new HttpError(400, message)
export const conflict = (message: string): HttpError => new HttpError(409, message)

/** dockerode and octokit both attach a numeric status to their errors. */
export function statusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const o = err as { statusCode?: unknown; status?: unknown }
  if (typeof o.statusCode === 'number') return o.statusCode
  if (typeof o.status === 'number') return o.status
  return null
}
