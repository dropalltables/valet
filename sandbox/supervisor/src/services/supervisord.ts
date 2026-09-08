import { execFile } from 'node:child_process'
import { request } from 'node:http'
import { promisify } from 'node:util'
import { SANDBOX, SUPERVISOR_TOKEN_ENV } from '@valet/shared'
import type { RegistryEntry } from './registry.js'

/**
 * supervisord is driven two ways, each where it is the most robust:
 *
 * - Process state comes from the XML-RPC API on supervisord's UNIX socket
 *   (`getAllProcessInfo`): typed fields (state, pid, start, exitstatus) instead of
 *   the human-oriented `supervisorctl status` text, whose columns change shape
 *   per state and never include the exit code.
 * - Unit changes go through `supervisorctl update`, which owns the add/change/
 *   remove diff of process groups after a config reload.
 *
 * Both need the socket to be `chown root:valet, chmod 0770` (see the image config).
 */

const SOCKET = '/var/run/supervisor.sock'
const RPC_TIMEOUT_MS = 15_000
const run = promisify(execFile)

export const UNITS_DIR = '/etc/supervisor/conf.d/services'
export const unitName = (service: string): string => `svc-${service}`
export const unitFile = (service: string): string => `${UNITS_DIR}/${unitName(service)}.conf`
export const logFile = (service: string): string => `${SANDBOX.serviceLogsDir}/${service}.log`

/** supervisord process states (`supervisor.states.ProcessStates`). */
export const STATE = {
  STOPPED: 0,
  STARTING: 10,
  RUNNING: 20,
  BACKOFF: 30,
  STOPPING: 40,
  EXITED: 100,
  FATAL: 200,
  UNKNOWN: 1000,
} as const

/** XML-RPC fault codes (`supervisor.xmlrpc.Faults`). */
export const FAULT = {
  BAD_NAME: 10,
  ABNORMAL_TERMINATION: 40,
  SPAWN_ERROR: 50,
  ALREADY_STARTED: 60,
  NOT_RUNNING: 70,
} as const

export type ProcessInfo = {
  name: string
  group: string
  state: number
  statename: string
  /** Epoch seconds of the last spawn, 0 when never started. */
  start: number
  stop: number
  now: number
  pid: number
  /** Status of the last exit; 0 while running or never exited, -1 when killed by a signal. */
  exitstatus: number
  spawnerr: string
  description: string
}

export class SupervisordFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'SupervisordFault'
  }
}

// ---- XML-RPC ------------------------------------------------------------------

type XmlValue = string | number | boolean | null | XmlValue[] | { [key: string]: XmlValue }

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

function encodeParam(v: string | number | boolean): string {
  if (typeof v === 'string') return `<value><string>${escapeXml(v)}</string></value>`
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`
  return `<value><int>${v}</int></value>`
}

/**
 * Minimal parser for what Python's xmlrpc marshaller emits: no attributes, no
 * CDATA, elements exactly as documented. A cursor walks the string once.
 */
class XmlCursor {
  pos = 0
  constructor(private readonly xml: string) {}

  private skipWs(): void {
    while (this.pos < this.xml.length && /\s/.test(this.xml[this.pos] ?? '')) this.pos += 1
  }

  peekTag(): string | null {
    this.skipWs()
    if (this.xml[this.pos] !== '<') return null
    const end = this.xml.indexOf('>', this.pos)
    if (end === -1) throw new Error('xml-rpc: unterminated tag')
    return this.xml.slice(this.pos + 1, end)
  }

  expect(tag: string): void {
    const got = this.peekTag()
    if (got !== tag) throw new Error(`xml-rpc: expected <${tag}>, got ${got === null ? 'text' : `<${got}>`}`)
    this.pos += tag.length + 2
  }

  /** Text up to the given closing tag, consuming the tag. */
  textUntil(closeTag: string): string {
    const end = this.xml.indexOf(`</${closeTag}>`, this.pos)
    if (end === -1) throw new Error(`xml-rpc: missing </${closeTag}>`)
    const text = this.xml.slice(this.pos, end)
    this.pos = end + closeTag.length + 3
    return unescapeXml(text)
  }

  value(): XmlValue {
    this.expect('value')
    const tag = this.peekTag()
    let out: XmlValue
    switch (tag) {
      case 'string':
        this.expect('string')
        out = this.textUntil('string')
        break
      case 'int':
      case 'i4':
        this.expect(tag)
        out = Number(this.textUntil(tag))
        break
      case 'double':
        this.expect('double')
        out = Number(this.textUntil('double'))
        break
      case 'boolean':
        this.expect('boolean')
        out = this.textUntil('boolean').trim() === '1'
        break
      case 'nil/':
        this.expect('nil/')
        out = null
        break
      case 'array': {
        this.expect('array')
        this.expect('data')
        const items: XmlValue[] = []
        while (this.peekTag() === 'value') items.push(this.value())
        this.expect('/data')
        this.expect('/array')
        out = items
        break
      }
      case 'struct': {
        this.expect('struct')
        const obj: { [key: string]: XmlValue } = {}
        while (this.peekTag() === 'member') {
          this.expect('member')
          this.expect('name')
          const name = this.textUntil('name')
          obj[name] = this.value()
          this.expect('/member')
        }
        this.expect('/struct')
        out = obj
        break
      }
      case null:
        // Untyped <value>text</value> is a string.
        out = this.textUntil('value')
        return out
      default:
        throw new Error(`xml-rpc: unsupported type <${tag}>`)
    }
    this.expect('/value')
    return out
  }
}

function parseResponse(xml: string): XmlValue {
  const c = new XmlCursor(xml.replace(/^\s*<\?xml[^>]*\?>/, ''))
  c.expect('methodResponse')
  const tag = c.peekTag()
  if (tag === 'fault') {
    c.expect('fault')
    const fault = c.value() as { faultCode?: XmlValue; faultString?: XmlValue }
    throw new SupervisordFault(Number(fault.faultCode ?? 0), String(fault.faultString ?? 'fault'))
  }
  c.expect('params')
  c.expect('param')
  const value = c.value()
  c.expect('/param')
  c.expect('/params')
  return value
}

export function rpc(method: string, params: Array<string | number | boolean> = []): Promise<XmlValue> {
  const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params
    .map((p) => `<param>${encodeParam(p)}</param>`)
    .join('')}</params></methodCall>`
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: SOCKET, path: '/RPC2', method: 'POST', headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(parseResponse(Buffer.concat(chunks).toString('utf8')))
          } catch (err) {
            reject(err)
          }
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(RPC_TIMEOUT_MS, () => req.destroy(new Error(`supervisord ${method}: timeout`)))
    req.on('error', (err) => reject(new Error(`supervisord ${method}: ${err.message}`)))
    req.end(body)
  })
}

function asInfo(v: XmlValue): ProcessInfo {
  const o = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, XmlValue>
  const num = (k: string): number => (typeof o[k] === 'number' ? (o[k] as number) : 0)
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  return {
    name: str('name'),
    group: str('group'),
    state: num('state'),
    statename: str('statename'),
    start: num('start'),
    stop: num('stop'),
    now: num('now'),
    pid: num('pid'),
    exitstatus: num('exitstatus'),
    spawnerr: str('spawnerr'),
    description: str('description'),
  }
}

export async function allProcessInfo(): Promise<ProcessInfo[]> {
  const v = await rpc('supervisor.getAllProcessInfo')
  return Array.isArray(v) ? v.map(asInfo) : []
}

/** Null when supervisord has no such program (unit not loaded). */
export async function processInfo(unit: string): Promise<ProcessInfo | null> {
  try {
    return asInfo(await rpc('supervisor.getProcessInfo', [unit]))
  } catch (err) {
    if (err instanceof SupervisordFault && err.code === FAULT.BAD_NAME) return null
    throw err
  }
}

/** Idempotent: an already running unit is left alone. */
export async function startUnit(unit: string): Promise<void> {
  try {
    await rpc('supervisor.startProcess', [unit, false])
  } catch (err) {
    if (err instanceof SupervisordFault && err.code === FAULT.ALREADY_STARTED) return
    throw err
  }
}

/** Idempotent: a unit that is not running is left alone. Waits for the stop. */
export async function stopUnit(unit: string): Promise<void> {
  try {
    await rpc('supervisor.stopProcess', [unit, true])
  } catch (err) {
    if (err instanceof SupervisordFault && err.code === FAULT.NOT_RUNNING) return
    throw err
  }
}

/** Reloads the config and applies added, changed, and removed process groups. */
export async function updateUnits(): Promise<string> {
  try {
    const { stdout } = await run('supervisorctl', ['update'], { timeout: 60_000 })
    return stdout.trim()
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    throw new Error(`supervisorctl update: ${(e.stderr || e.stdout || e.message).trim()}`)
  }
}

// ---- unit files -------------------------------------------------------------------

/**
 * supervisord expands `%(here)s`-style strings in every option, so a literal `%`
 * must be doubled. The unit carries only generated values (a validated name, a
 * port, the portal URL, the thread id): the command, the working directory, and the
 * service's own env live in `SANDBOX.serviceSpecsDir` files read by the launcher,
 * because supervisord's parser has no quoting (a newline in a value starts a new
 * key or section, ` ;` starts a comment) and splits `command=` with shlex, so
 * arbitrary user strings cannot travel through the config safely.
 */
const pct = (s: string): string => s.replace(/%/g, '%%')

export function unitConf(entry: RegistryEntry, opts: { threadId: string | null; url: string | null }): string {
  const env: Record<string, string> = {}
  if (entry.port !== null) env.PORT = String(entry.port)
  if (opts.url !== null) env.PUBLIC_URL = opts.url
  if (opts.threadId !== null) env.VALET_THREAD_ID = opts.threadId
  env.VALET_SERVICE = entry.name
  // supervisord children inherit the container env, token included. Blanking it keeps the
  // token out of service logs and env dumps; it is not isolation: services run as the same
  // uid as the supervisor (and have sudo), so the container is the trust boundary.
  env[SUPERVISOR_TOKEN_ENV] = ''
  const environment = Object.entries(env)
    .map(([k, v]) => `${k}="${pct(v)}"`)
    .join(',')
  return [
    `; Generated by the Valet supervisor from ${SANDBOX.servicesFile}; edits are overwritten.`,
    `[program:${unitName(entry.name)}]`,
    `command=/usr/local/bin/valet-run-service ${entry.name}`,
    'user=valet',
    `environment=${environment}`,
    'autostart=true',
    'autorestart=true',
    'startsecs=1',
    'startretries=10',
    'stopasgroup=true',
    'killasgroup=true',
    'stopwaitsecs=10',
    `stdout_logfile=${pct(logFile(entry.name))}`,
    'stdout_logfile_maxbytes=10MB',
    'stdout_logfile_backups=2',
    'redirect_stderr=true',
    '',
  ].join('\n')
}

/** `KEY='value'` lines for `set -a; . file`: single quotes carry any byte but a quote, which is escaped. */
export function envFile(env: Record<string, string>): string {
  const quote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`
  return Object.entries(env)
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join('\n')
    .concat(Object.keys(env).length > 0 ? '\n' : '')
}
