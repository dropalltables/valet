import { readFile, readdir, readlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { SANDBOX, type PortsReply } from '@valet/shared'

/** `st` column of /proc/net/tcp for TCP_LISTEN. */
const LISTEN = '0A'
const HIDDEN_PORTS = new Set<number>([SANDBOX.supervisorPort, SANDBOX.vncPort])
/**
 * Docker's embedded DNS resolver listens on 127.0.0.11 inside every container on a
 * user-defined network; the socket belongs to dockerd, not to anything in here.
 */
const DOCKER_DNS_ADDRESSES = new Set(['0B00007F', '0000000000000000FFFF00000B00007F'])
/**
 * The agent CLIs open loopback listeners of their own (IDE bridges, MCP transports);
 * those are never a project's server.
 */
const AGENT_PROCESSES = new Set(['claude', 'codex'])

type Listener = { port: number; inode: number; loopback: boolean }

/**
 * /proc/net/tcp prints IPv4 addresses as little-endian hex (127.0.0.1 = 0100007F);
 * tcp6 prints 16 bytes in 32-bit little-endian words (::1 = ...01000000, and
 * v4-mapped ::ffff:127.x.x.x = ...FFFF0000xxxxxx7F).
 */
export function isLoopback(hexAddress: string): boolean {
  if (hexAddress.length === 8) return hexAddress.endsWith('7F')
  if (hexAddress.length !== 32) return false
  if (hexAddress === '00000000000000000000000001000000') return true
  return hexAddress.startsWith('0000000000000000FFFF0000') && hexAddress.endsWith('7F')
}

/** Listening ports and their socket inodes from one /proc/net/tcp{,6} table. */
async function listenTable(file: string): Promise<Listener[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const out: Listener[] = []
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode ...
    if (cols.length < 10 || cols[3] !== LISTEN) continue
    const local = cols[1] ?? ''
    const address = local.slice(0, local.lastIndexOf(':'))
    if (DOCKER_DNS_ADDRESSES.has(address)) continue
    const port = parseInt(local.slice(local.lastIndexOf(':') + 1), 16)
    const inode = Number(cols[9])
    if (!Number.isInteger(port) || !Number.isInteger(inode) || inode === 0) continue
    out.push({ port, inode, loopback: isLoopback(address) })
  }
  return out
}

/**
 * Resolves socket inodes to pids by scanning /proc/<pid>/fd. Only processes of the
 * same uid are readable, which covers everything the agent starts; root-owned
 * listeners stay pid-less.
 */
async function ownersOf(inodes: Set<number>): Promise<Map<number, number>> {
  const owners = new Map<number, number>()
  const wanted = new Set(inodes)
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter((n) => /^\d+$/.test(n))
  for (const pidStr of pids) {
    if (wanted.size === 0) break
    const pid = Number(pidStr)
    let fds: string[]
    try {
      fds = await readdir(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let link: string
      try {
        link = await readlink(`/proc/${pid}/fd/${fd}`)
      } catch {
        continue
      }
      const m = /^socket:\[(\d+)\]$/.exec(link)
      if (!m) continue
      const inode = Number(m[1])
      if (!wanted.has(inode)) continue
      owners.set(inode, pid)
      wanted.delete(inode)
    }
  }
  return owners
}

/** Parent pid from /proc/<pid>/stat: the field after the parenthesised comm, which may itself contain spaces. */
async function parentPid(pid: number): Promise<number | null> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const ppid = Number(rest[1])
  return Number.isInteger(ppid) ? ppid : null
}

/** Whether `pid` is one of `roots` or descends from one; stops at init or at a pid that is gone. */
async function descendsFrom(pid: number, roots: Set<number>, cache: Map<number, boolean>): Promise<boolean> {
  const chain: number[] = []
  let cur: number | null = pid
  let found = false
  while (cur !== null && cur > 1) {
    const known = cache.get(cur)
    if (known !== undefined) {
      found = known
      break
    }
    if (roots.has(cur)) {
      found = true
      break
    }
    chain.push(cur)
    cur = await parentPid(cur)
  }
  for (const p of chain) cache.set(p, found)
  return found
}

async function processName(pid: number): Promise<string | null> {
  const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
  const argv0 = cmdline.split('\0')[0]
  if (argv0) return basename(argv0)
  const comm = await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')
  return comm.trim() || null
}

/**
 * Listening TCP ports, except the supervisor's and VNC's, Docker's DNS, and
 * loopback-only listeners of the agent CLIs themselves or of anything under
 * `excludePids` (the agent process tree). Only loopback, because the agent's own
 * bridges bind there while a dev server it starts from a background shell, also a
 * descendant, is told to bind 0.0.0.0 and must stay visible. `serviceByPort` names
 * the registered service each port was assigned to.
 */
export async function listPorts(excludePids: number[] = [], serviceByPort: Map<number, string> = new Map()): Promise<PortsReply> {
  const sockets = [...(await listenTable('/proc/net/tcp')), ...(await listenTable('/proc/net/tcp6'))].filter(
    (s) => !HIDDEN_PORTS.has(s.port),
  )
  const owners = await ownersOf(new Set(sockets.map((s) => s.inode)))
  const roots = new Set(excludePids)
  const ancestry = new Map<number, boolean>()
  const names = new Map<number, string | null>()
  const nameOf = async (pid: number): Promise<string | null> => {
    if (!names.has(pid)) names.set(pid, await processName(pid))
    return names.get(pid) ?? null
  }
  // One entry per port: v4 and v6 sockets of the same server are one service.
  const byPort = new Map<number, number | null>()
  for (const s of sockets) {
    const pid = owners.get(s.inode) ?? null
    if (pid !== null) {
      if (s.loopback && AGENT_PROCESSES.has((await nameOf(pid)) ?? '')) continue
      if (s.loopback && roots.size > 0 && (await descendsFrom(pid, roots, ancestry))) continue
    }
    const cur = byPort.get(s.port)
    if (cur === undefined || (cur === null && pid !== null)) byPort.set(s.port, pid)
  }
  const ports = await Promise.all(
    [...byPort.entries()]
      .sort(([a], [b]) => a - b)
      .map(async ([port, pid]) => ({ port, pid, process: pid === null ? null : await nameOf(pid), service: serviceByPort.get(port) ?? null })),
  )
  return { ports }
}

/** `excludePids=12,34`; anything that is not a positive integer is ignored. */
export function parseExcludePids(raw: string | null): number[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
}
