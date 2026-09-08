import { isAbsolute, resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { RESERVED_SERVICE_ENV, serviceNameSchema, type ServicePortal } from '@valet/shared'

/**
 * `.valet/services.yaml`:
 *
 *   services:
 *     web:
 *       command: npm run dev          # required; runs in `cwd` (default: the repo)
 *       cwd: apps/web
 *       port: 3000                    # else assigned when portal or health is set
 *       portal: true                  # or { path: /docs, title: Docs, description: ... }
 *       health: /healthz              # GET must answer 2xx/3xx
 *       env:
 *         API_URL: ${services.api.publicURL}
 */

const envValue = z.union([z.string(), z.number(), z.boolean()]).transform(String)

const portalSchema = z.union([
  z.boolean(),
  z.object({ path: z.string().optional(), title: z.string().optional(), description: z.string().optional() }).strict(),
])

const declaredSchema = z
  .object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    env: z.record(z.string(), envValue).optional(),
    portal: portalSchema.optional(),
    health: z.string().startsWith('/').optional(),
  })
  .strict()

const fileSchema = z.object({ services: z.record(serviceNameSchema, declaredSchema) }).strict()

export type Declared = {
  name: string
  command: string
  cwd: string
  port: number | null
  /** Raw values; `${services.<name>.publicURL}` references are resolved by `resolveEnv`. */
  env: Record<string, string>
  portal: ServicePortal
  health: string | null
}

const REFERENCE_RE = /\$\{services\.([^.}]+)\.([^}]+)\}/g

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'services.yaml'}: ${i.message}`).join('; ')
}

export function normalizePortal(name: string, portal: boolean | { path?: string | undefined; title?: string | undefined } | undefined): ServicePortal {
  if (!portal) return false
  if (portal === true) return { path: '/', title: name }
  return { path: portal.path ?? '/', title: portal.title ?? name }
}

/** Throws an Error whose message names the problem; the caller reports it as the ensure error. */
export function parseServicesYaml(text: string, repo: string): Declared[] {
  let doc: unknown
  try {
    doc = parse(text)
  } catch (err) {
    throw new Error(`services.yaml: ${(err as Error).message}`)
  }
  const parsed = fileSchema.safeParse(doc)
  if (!parsed.success) throw new Error(issues(parsed.error))
  const declared: Declared[] = []
  const portOwner = new Map<number, string>()
  for (const [name, spec] of Object.entries(parsed.data.services)) {
    const env = spec.env ?? {}
    for (const key of Object.keys(env)) {
      if ((RESERVED_SERVICE_ENV as readonly string[]).includes(key)) throw new Error(`services.${name}.env.${key}: set by Valet, cannot be declared`)
    }
    const portal = normalizePortal(name, spec.portal)
    const explicit = spec.port ?? null
    if (explicit !== null) {
      const other = portOwner.get(explicit)
      if (other !== undefined) throw new Error(`services.${name}.port: ${explicit} is also used by ${other}`)
      portOwner.set(explicit, name)
    }
    declared.push({
      name,
      command: spec.command,
      cwd: spec.cwd === undefined ? repo : isAbsolute(spec.cwd) ? spec.cwd : resolve(repo, spec.cwd),
      port: explicit,
      env,
      portal,
      health: spec.health ?? null,
    })
  }
  checkReferences(declared)
  return declared
}

/** Referenced service names per service; throws on unknown targets, unsupported properties, and cycles. */
function checkReferences(declared: Declared[]): void {
  const names = new Set(declared.map((d) => d.name))
  const edges = new Map<string, Set<string>>()
  for (const d of declared) {
    const targets = new Set<string>()
    for (const value of Object.values(d.env)) {
      for (const m of value.matchAll(REFERENCE_RE)) {
        const [, target, prop] = m
        if (!target || !names.has(target)) throw new Error(`services.${d.name}.env: unknown service in ${m[0]}`)
        if (prop !== 'publicURL') throw new Error(`services.${d.name}.env: only publicURL can be referenced (${m[0]})`)
        targets.add(target)
      }
    }
    edges.set(d.name, targets)
  }
  // Depth-first cycle check: grey nodes are on the current path.
  const color = new Map<string, 'grey' | 'black'>()
  const visit = (name: string, path: string[]): void => {
    const c = color.get(name)
    if (c === 'black') return
    if (c === 'grey') throw new Error(`services.yaml: circular reference ${[...path, name].join(' -> ')}`)
    color.set(name, 'grey')
    for (const next of edges.get(name) ?? []) visit(next, [...path, name])
    color.set(name, 'black')
  }
  for (const name of names) visit(name, [])
}

/** Whether a declared service needs a port: it asked for one, is a portal, or has a health path. */
export function wantsPort(d: Declared): boolean {
  return d.port !== null || d.portal !== false || d.health !== null
}

export function resolveEnv(env: Record<string, string>, urls: Map<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    out[key] = value.replace(REFERENCE_RE, (whole, target: string) => {
      const url = urls.get(target)
      if (url === undefined || url === null) throw new Error(`env.${key}: ${whole} has no URL (service ${target} has no port)`)
      return url
    })
  }
  return out
}
