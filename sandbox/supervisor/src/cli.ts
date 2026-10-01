/**
 * `valet`: the in-sandbox command for managed services. Talks to the supervisor
 * over its UNIX control socket (no token: the container is the trust boundary).
 * Bundled separately from the supervisor and installed at /usr/local/bin/valet.
 */

import { request } from 'node:http'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { WebSocket } from 'ws'
import {
  SERVICE_ENV,
  SANDBOX,
  type CreateManagedServiceReply,
  type CreateManagedServiceRequest,
  type EnsureReply,
  type ManagedService,
  type ManagedServiceReadiness,
  type ManagedServicesReply,
} from '@valet/shared'

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message)
  }
}

const HELP = {
  root: `Usage:
  valet service start <name> --command '<cmd>' [--cwd <dir>] [--port <n>] [--browser] [--title <t>] [--health </path>] [--env K=V]...
  valet service start|stop|restart|status|remove <name>
  valet service logs <name> [-n <lines>] [-f]
  valet service list                 (also: valet services)
  valet services ensure [--json]     apply .valet/services.yaml
  valet url <port>                service URL for a port

A service gets PORT and PUBLIC_URL when it has a port (--port, --browser, or --health),
restarts when the sandbox wakes, and logs to ${SANDBOX.serviceLogsDir}/<name>.log.`,
  start: `Usage: valet service start <name> [--command '<cmd>' [--cwd <dir>] [--port <n>] [--browser] [--title <t>] [--health </path>] [--env K=V]...]

With --command: register (or replace) the service and start it. Without: start a registered service.
  --cwd      working directory (default: the repository)
  --port     listen port; without it one is assigned when --browser or --health is given
  --browser   show it in the Services tab with a mini-browser
  --title    service title (default: the name)
  --health   path that must answer 2xx/3xx before the service counts as ready
  --env      extra variable, repeatable`,
  logs: `Usage: valet service logs <name> [-n <lines>] [-f]
  -n, --lines   last N lines (default 200)
  -f, --follow  keep printing as the log grows`,
  ensure: `Usage: valet services ensure [--json]
Reconciles ${SANDBOX.servicesYaml} into the registered services and waits for each to answer.`,
  named: (verb: string) => `Usage: valet service ${verb} <name>`,
  browser: 'Usage: valet url <port>',
}

// ---- transport -------------------------------------------------------------------

function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = request(
      {
        socketPath: SANDBOX.controlSocket,
        path,
        method,
        headers: payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = res.statusCode ?? 0
          if (status === 204) return resolve(undefined as T)
          if (res.headers['content-type']?.startsWith('text/plain')) {
            if (status >= 400) return reject(new CliError(text.trim() || `HTTP ${status}`))
            return resolve(text as T)
          }
          let json: unknown
          try {
            json = JSON.parse(text)
          } catch {
            return reject(new CliError(`supervisor answered ${status} without JSON`))
          }
          if (status >= 400) {
            const error = (json as { error?: unknown }).error
            return reject(new CliError(typeof error === 'string' ? error : `HTTP ${status}`))
          }
          resolve(json as T)
        })
      },
    )
    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(new CliError(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? 'the Valet supervisor is not running in this sandbox' : err.message))
    })
    req.end(payload ?? undefined)
  })
}

// ---- formatting --------------------------------------------------------------------

function describeReadiness(name: string, r: ManagedServiceReadiness, port: number | null): string {
  const where = port === null ? '' : ` on port ${port}`
  switch (r.status) {
    case 'listening':
      return `listening${where}`
    case 'responding':
      return `responding (HTTP ${r.httpStatus ?? '?'})${where}`
    case 'not-responding':
      return `NOT RESPONDING (${r.error ?? 'unknown'}); logs: valet service logs ${name}`
    case 'exited':
      return `${r.error ?? 'exited'}; logs: valet service logs ${name}`
    case 'skipped':
      return 'started'
  }
}

function stateWord(s: ManagedService): string {
  if ((s.state === 'exited' || s.state === 'failed' || s.state === 'starting') && s.lastExitCode !== null) return `${s.state} (exit ${s.lastExitCode})`
  return s.state
}

function uptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
}

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? []
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  ').trimEnd()).join('\n')
}

// ---- commands -------------------------------------------------------------------------

function parse<O extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: O, help: string) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(help)
    process.exit(0)
  }
  try {
    return parseArgs({ options, args, allowPositionals: true, strict: true })
  } catch (err) {
    throw new CliError(`${(err as Error).message}\n${help}`, 2)
  }
}

function requireName(positionals: string[], help: string): string {
  const name = positionals[0]
  if (!name || positionals.length > 1) throw new CliError(help, 2)
  return name
}

async function serviceStart(args: string[]): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      command: { type: 'string' },
      cwd: { type: 'string' },
      port: { type: 'string' },
      browser: { type: 'boolean' },
      title: { type: 'string' },
      health: { type: 'string' },
      env: { type: 'string', multiple: true },
    },
    HELP.start,
  )
  const name = requireName(positionals, HELP.start)
  let reply: CreateManagedServiceReply
  if (values.command === undefined) {
    if (values.cwd !== undefined || values.port !== undefined || values.browser || values.title !== undefined || values.health !== undefined || values.env)
      throw new CliError('options other than the name need --command', 2)
    reply = await api<CreateManagedServiceReply>('POST', `/managed-services/${encodeURIComponent(name)}/start`)
  } else {
    const body: CreateManagedServiceRequest = { name, command: values.command }
    if (values.cwd !== undefined) body.cwd = values.cwd.startsWith('/') ? values.cwd : `${process.cwd()}/${values.cwd}`
    if (values.port !== undefined) {
      const port = Number(values.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError('--port must be 1-65535', 2)
      body.port = port
    }
    if (values.browser || values.title !== undefined) body.browser = values.title === undefined ? true : { title: values.title }
    if (values.health !== undefined) body.health = values.health
    if (values.env) {
      body.env = {}
      for (const pair of values.env) {
        const eq = pair.indexOf('=')
        if (eq <= 0) throw new CliError(`--env expects KEY=VALUE, got ${pair}`, 2)
        body.env[pair.slice(0, eq)] = pair.slice(eq + 1)
      }
    }
    reply = await api<CreateManagedServiceReply>('POST', '/managed-services', body)
  }
  const { service, readiness } = reply
  const line = `${service.name}: ${describeReadiness(service.name, readiness, service.port)}`
  if (readiness.ok) console.log(line)
  else console.error(line)
  if (service.url) console.log(service.url)
  return readiness.ok ? 0 : 1
}

async function serviceAction(verb: 'stop' | 'restart', args: string[]): Promise<number> {
  const { positionals } = parse(args, {}, HELP.named(verb))
  const name = requireName(positionals, HELP.named(verb))
  const { service, readiness } = await api<CreateManagedServiceReply>('POST', `/managed-services/${encodeURIComponent(name)}/${verb}`)
  if (verb === 'stop') {
    console.log(`${service.name}: ${service.state}`)
    return 0
  }
  const line = `${service.name}: ${describeReadiness(service.name, readiness, service.port)}`
  if (readiness.ok) console.log(line)
  else console.error(line)
  if (service.url) console.log(service.url)
  return readiness.ok ? 0 : 1
}

async function serviceRemove(args: string[]): Promise<number> {
  const { positionals } = parse(args, {}, HELP.named('remove'))
  const name = requireName(positionals, HELP.named('remove'))
  await api<void>('DELETE', `/managed-services/${encodeURIComponent(name)}`)
  console.log(`${name}: removed`)
  return 0
}

async function serviceStatus(args: string[]): Promise<number> {
  const { positionals } = parse(args, {}, HELP.named('status'))
  const name = requireName(positionals, HELP.named('status'))
  const s = await api<ManagedService>('GET', `/managed-services/${encodeURIComponent(name)}`)
  const detail = [s.pid !== null ? `pid ${s.pid}` : null, s.uptimeSeconds !== null ? `up ${uptime(s.uptimeSeconds)}` : null, `${s.restarts} restarts`].filter(Boolean).join(', ')
  const rows: string[][] = [
    ['state:', `${stateWord(s)} (${detail})`],
    ['port:', s.port === null ? '-' : String(s.port)],
    ['url:', s.url ?? '-'],
    ['command:', s.command],
    ['cwd:', s.cwd],
    ['health:', s.health ?? '-'],
    ['browser:', s.browser === false ? '-' : `${s.browser.title} (${s.browser.path})`],
    ['review:', s.review ? 'on' : 'off'],
    ['source:', s.source === 'yaml' ? '.valet/services.yaml' : 'ad hoc'],
    ['logs:', `${SANDBOX.serviceLogsDir}/${s.name}.log`],
  ]
  console.log(`${s.name}\n${table(rows.map(([k, v]) => [`  ${k}`, v ?? '']))}`)
  return s.state === 'running' ? 0 : 1
}

async function serviceList(args: string[]): Promise<number> {
  parse(args, {}, 'Usage: valet service list')
  const { services } = await api<ManagedServicesReply>('GET', '/managed-services')
  if (services.length === 0) {
    console.log('No services')
    return 0
  }
  console.log(table([['NAME', 'STATE', 'PORT', 'URL'], ...services.map((s) => [s.name, stateWord(s), s.port === null ? '-' : String(s.port), s.url ?? '-'])]))
  return 0
}

function serviceLogs(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { lines: { type: 'string', short: 'n' }, follow: { type: 'boolean', short: 'f' } }, HELP.logs)
  const name = requireName(positionals, HELP.logs)
  const lines = values.lines === undefined ? 200 : Number(values.lines)
  if (!Number.isInteger(lines) || lines < 0) throw new CliError('-n must be a non-negative integer', 2)
  const path = `/managed-services/${encodeURIComponent(name)}/logs?lines=${lines}`
  if (!values.follow) {
    return api<string>('GET', path).then((text) => {
      process.stdout.write(text)
      return 0
    })
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${SANDBOX.controlSocket}:${path}`)
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { t: string; data: string }
      if (frame.t === 'data') process.stdout.write(Buffer.from(frame.data, 'base64'))
    })
    ws.on('unexpected-response', (_req, res) => reject(new CliError(res.statusCode === 404 ? `no service named ${name}` : `HTTP ${res.statusCode}`)))
    ws.on('error', (err: NodeJS.ErrnoException) => reject(new CliError(err.code === 'ENOENT' ? 'the Valet supervisor is not running in this sandbox' : err.message)))
    ws.on('close', () => resolve(0))
    process.once('SIGINT', () => {
      ws.close()
      resolve(0)
    })
  })
}

async function servicesEnsure(args: string[]): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean' } }, HELP.ensure)
  const reply = await api<EnsureReply>('POST', '/managed-services/ensure')
  if (values.json) {
    console.log(JSON.stringify(reply, null, 2))
    return reply.ok ? 0 : 1
  }
  if (reply.error) throw new CliError(reply.error)
  if (reply.services.length === 0) console.log('No services declared')
  for (const s of reply.services) {
    const readiness: ManagedServiceReadiness = { ok: s.ok, status: s.status, httpStatus: s.healthStatus ?? null, error: s.healthError ?? null }
    const line = `${s.name}: ${describeReadiness(s.name, readiness, s.port)}${s.url ? `  ${s.url}` : ''}`
    if (s.ok) console.log(line)
    else console.error(line)
  }
  return reply.ok ? 0 : 1
}

function service(args: string[]): number {
  const { positionals } = parse(args, {}, HELP.browser)
  const port = Number(requireName(positionals, HELP.browser))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError('port must be 1-65535', 2)
  const template = process.env[SERVICE_ENV.urlTemplate]
  if (!template) throw new CliError(`${SERVICE_ENV.urlTemplate} is not set; service URLs are unavailable in this sandbox`)
  console.log(template.replace('{port}', String(port)))
  return 0
}

async function main(argv: string[]): Promise<number> {
  const [group, verb, ...rest] = argv
  if (group === undefined || group === '--help' || group === '-h' || group === 'help') {
    console.log(HELP.root)
    return group === undefined ? 2 : 0
  }
  switch (group) {
    case 'service':
      switch (verb) {
        case 'start':
          return serviceStart(rest)
        case 'stop':
        case 'restart':
          return serviceAction(verb, rest)
        case 'status':
          return serviceStatus(rest)
        case 'remove':
          return serviceRemove(rest)
        case 'logs':
          return serviceLogs(rest)
        case 'list':
          return serviceList(rest)
        case undefined:
        case '--help':
        case '-h':
          console.log(HELP.root)
          return verb === undefined ? 2 : 0
        default:
          throw new CliError(`unknown command: service ${verb}\n${HELP.root}`, 2)
      }
    case 'managed-services':
      if (verb === undefined) return serviceList(rest)
      if (verb === 'ensure') return servicesEnsure(rest)
      if (verb === 'list') return serviceList(rest)
      if (verb === '--help' || verb === '-h') {
        console.log(HELP.root)
        return 0
      }
      throw new CliError(`unknown command: services ${verb}\n${HELP.root}`, 2)
    case 'service':
      return service(verb === undefined ? [] : [verb, ...rest])
    default:
      throw new CliError(`unknown command: ${group}\n${HELP.root}`, 2)
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(err instanceof CliError ? err.exitCode : 1)
  },
)
