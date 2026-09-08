type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const minLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? 'info'

function write(level: Level, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel]) return
  const line = { time: new Date().toISOString(), level, scope, message, ...fields }
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  out.write(`${JSON.stringify(line, replacer)}\n`)
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  return value
}

export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export function logger(scope: string): Logger {
  return {
    debug: (m, f) => write('debug', scope, m, f),
    info: (m, f) => write('info', scope, m, f),
    warn: (m, f) => write('warn', scope, m, f),
    error: (m, f) => write('error', scope, m, f),
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
