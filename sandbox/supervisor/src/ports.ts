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

/** Listening ports and their socket inodes from one /proc/net/tcp{,6} table. */
async function listenTable(file: string): Promise<Array<{ port: number; inode: number }>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const out: Array<{ port: number; inode: number }> = []
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode ...
    if (cols.length < 10 || cols[3] !== LISTEN) continue
    const local = cols[1] ?? ''
    if (DOCKER_DNS_ADDRESSES.has(local.slice(0, local.lastIndexOf(':')))) continue
    const port = parseInt(local.slice(local.lastIndexOf(':') + 1), 16)
    const inode = Number(cols[9])
    if (!Number.isInteger(port) || !Number.isInteger(inode) || inode === 0) continue
    out.push({ port, inode })
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

async function processName(pid: number): Promise<string | null> {
  const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
  const argv0 = cmdline.split('\0')[0]
  if (argv0) return basename(argv0)
  const comm = await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')
  return comm.trim() || null
}

export async function listPorts(): Promise<PortsReply> {
  const sockets = [...(await listenTable('/proc/net/tcp')), ...(await listenTable('/proc/net/tcp6'))].filter(
    (s) => !HIDDEN_PORTS.has(s.port),
  )
  const owners = await ownersOf(new Set(sockets.map((s) => s.inode)))
  // One entry per port: v4 and v6 sockets of the same server are one portal.
  const byPort = new Map<number, number | null>()
  for (const s of sockets) {
    const pid = owners.get(s.inode) ?? null
    const cur = byPort.get(s.port)
    if (cur === undefined || (cur === null && pid !== null)) byPort.set(s.port, pid)
  }
  const ports = await Promise.all(
    [...byPort.entries()]
      .sort(([a], [b]) => a - b)
      .map(async ([port, pid]) => ({ port, pid, process: pid === null ? null : await processName(pid) })),
  )
  return { ports }
}
