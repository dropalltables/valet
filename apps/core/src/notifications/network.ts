import { lookup } from 'node:dns/promises'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { badRequest } from '../errors.js'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['2001:db8::', 32], ['ff00::', 8],
] as const) blocked.addSubnet(address, prefix, 'ipv6')

export function assertPublicAddress(address: string): void {
  const family = isIP(address)
  if (!family || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')) throw badRequest('notification target must resolve to a public address')
}

export function assertPostableUrl(raw: string): void {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest(`unsupported URL scheme: ${url.protocol}`)
  if (url.username || url.password) throw badRequest('notification target cannot contain credentials')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw badRequest(`unroutable host: ${url.hostname}`)
  if (isIP(host)) assertPublicAddress(host)
}

/** Resolve all addresses, reject mixed public/private answers, then pin the connection. */
export async function pinnedLookup(raw: string, allowNtfy = false): Promise<LookupFunction> {
  assertPostableUrl(raw)
  const url = new URL(raw)
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
  if (!addresses.length) throw badRequest('notification target has no addresses')
  if (!(allowNtfy && url.hostname === 'ntfy' && url.port === '8080')) {
    for (const address of addresses) assertPublicAddress(address.address)
  }
  return (_hostname, options, callback) => {
    const selected = options.family ? addresses.filter((a) => a.family === options.family) : addresses
    if (!selected.length) {
      callback(new Error('notification target has no matching address'), '', 4)
      return
    }
    if (options.all) callback(null, selected)
    else callback(null, selected[0]!.address, selected[0]!.family)
  }
}
