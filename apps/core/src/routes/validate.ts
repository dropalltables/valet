import { validator } from 'hono/validator'
import type { z } from 'zod'

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
}

/** JSON body validation that answers `{ error }` with 400 on failure. */
export function jsonBody<S extends z.ZodType>(schema: S) {
  return validator('json', (value, c) => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) return c.json({ error: formatIssues(parsed.error) }, 400)
    return parsed.data as z.infer<S>
  })
}

export function queryParams<S extends z.ZodType>(schema: S) {
  return validator('query', (value, c) => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) return c.json({ error: formatIssues(parsed.error) }, 400)
    return parsed.data as z.infer<S>
  })
}
