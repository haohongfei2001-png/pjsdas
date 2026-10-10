import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type RequestOptions, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import { WorkspaceSourceError } from './workspaceSource.js'

type Address = { address: string; family: number }
type ResolveAddresses = (hostname: string) => Promise<Address[]>
const privateV4 = new BlockList()
// IANA special-purpose registries (checked 2026-10-07). Deliberately reject
// whole special ranges, including their few publicly routed exceptions:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],
  ['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) privateV4.addSubnet(address, prefix, 'ipv4')
privateV4.addAddress('168.63.129.16', 'ipv4') // Cloud infrastructure service, not a public recruiting host.
const publicV6 = new BlockList(), specialV6 = new BlockList()
publicV6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3ffe::',16],['3fff::',20]] as const) specialV6.addSubnet(address, prefix, 'ipv6')

/** Conservatively accept public unicast addresses only. Mapped, transition and
 * documentation IPv6 ranges cannot encode a private destination behind DNS. */
export function isPublicDiscoveryAddress(address: string) {
  const family = isIP(address)
  if (family === 4) return !privateV4.check(address, 'ipv4')
  if (family === 6) return !address.includes('%') && publicV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6')
  return false
}
function checkedAddresses(addresses: Address[]) {
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32) throw new WorkspaceSourceError('DISCOVERY_SOURCE_NON_PUBLIC', 'The source has no bounded public address set.', false)
  if (addresses.some(item => !item || typeof item.address !== 'string' || ![4, 6].includes(item.family))) throw new WorkspaceSourceError('DISCOVERY_SOURCE_NON_PUBLIC', 'The source address response is invalid.', false)
  const copied = addresses.map(item => Object.freeze({ address: item.address, family: item.family }))
  if (copied.some(item => !isPublicDiscoveryAddress(item.address) || isIP(item.address) !== item.family)) {
    throw new WorkspaceSourceError('DISCOVERY_SOURCE_NON_PUBLIC', 'The source hostname includes a non-public address.', false)
  }
  return Object.freeze(copied)
}
async function withAbort<T>(pending: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) throw new WorkspaceSourceError('DISCOVERY_SOURCE_UNAVAILABLE', 'Source verification timed out.', true)
  let listener = () => {}
  const aborted = new Promise<never>((_, reject) => { listener = () => reject(new WorkspaceSourceError('DISCOVERY_SOURCE_UNAVAILABLE', 'Source verification timed out.', true)); signal.addEventListener('abort', listener, { once: true }) })
  try { return await Promise.race([pending, aborted]) }
  finally { signal.removeEventListener('abort', listener) }
}
export async function resolvePublicDiscoveryAddresses(hostname: string, signal: AbortSignal,
  resolve: ResolveAddresses = host => dnsLookup(host, { all: true, verbatim: true })) {
  if (signal.aborted) throw new WorkspaceSourceError('DISCOVERY_SOURCE_UNAVAILABLE', 'Source verification timed out.', true)
  const host = hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await withAbort(resolve(host), signal)
  return checkedAddresses(addresses)
}
export function pinnedDiscoveryLookup(hostname: string, addresses: readonly Address[]): LookupFunction {
  const pinned = checkedAddresses([...addresses])
  return (requested, options, callback) => {
    if (requested.toLowerCase() !== hostname.toLowerCase()) { callback(Object.assign(new Error('Source lookup host changed.'), { code: 'ENOTFOUND' }), []); return }
    const selected = options.family ? pinned.filter(item => item.family === options.family) : pinned
    if (!selected.length) { callback(Object.assign(new Error('No verified address for the requested family.'), { code: 'ENOTFOUND' }), []); return }
    if (options.all) callback(null, selected.map(item => ({ ...item })))
    else callback(null, selected[0]!.address, selected[0]!.family)
  }
}

type RequestTransport = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ReturnType<typeof httpRequest>
/** Preserve the original Host/TLS identity while pinning the validated DNS
 * result to this connection. No shared socket pool can reintroduce an earlier
 * private connection. Public-source reads never carry account credentials. */
export async function fetchPinnedPublicDiscoverySource(url: URL, init: RequestInit, dependencies: { resolve?: ResolveAddresses; request?: RequestTransport } = {}): Promise<Response> {
  url = new URL(url.toString()) // Do not let caller mutation change the host after DNS validation.
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Unsupported public-source transport target.', false)
  if (url.toString().length > 4096) throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Public-source URL exceeds its bounded size.', false)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const signal = init.signal ?? new AbortController().signal
  const headers = new Headers(init.headers)
  if ([...headers.keys()].some(key => !['accept', 'user-agent', 'content-type'].includes(key))) throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Public-source transport does not accept credential or custom headers.', false)
  if (!['GET', 'POST'].includes(init.method ?? 'GET') || init.body && !(init.body instanceof URLSearchParams)) throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Unsupported public-source request body or method.', false)
  const addresses = await resolvePublicDiscoveryAddresses(url.hostname, signal, dependencies.resolve)
  if (signal.aborted) throw new WorkspaceSourceError('DISCOVERY_SOURCE_UNAVAILABLE', 'Source verification timed out.', true)
  const request = dependencies.request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest)
  return new Promise<Response>((resolve, reject) => {
    const requestOptions: RequestOptions & { servername?: string } = { method: init.method ?? 'GET', headers: Object.fromEntries(headers), agent: false,
      signal, lookup: pinnedDiscoveryLookup(hostname, addresses), maxHeaderSize: 16_384,
      ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}) }
    const req = request(url, requestOptions, response => {
      try {
        const outputHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (name === 'set-cookie' || value === undefined) continue
          for (const part of Array.isArray(value) ? value : [value]) outputHeaders.append(name, part)
        }
        const status = response.statusCode ?? 502
        const body = [204,205,304].includes(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>
        if (!body) response.destroy()
        resolve(new Response(body, { status, headers: outputHeaders }))
      } catch (error) { response.destroy(); reject(error) }
    })
    req.once('error', reject)
    req.once('upgrade', (_response, socket) => { socket.destroy(); reject(new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Public-source reads cannot upgrade the connection.', false)) })
    req.end(init.body instanceof URLSearchParams ? init.body.toString() : undefined)
  })
}
