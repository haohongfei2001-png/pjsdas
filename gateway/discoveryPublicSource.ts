import { isIP } from 'node:net'
import { fetchPinnedPublicDiscoverySource, isPublicDiscoveryAddress } from './discoveryNetwork.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const SOURCE_VERIFY_TIMEOUT_MS = 8_000
const SOURCE_VERIFY_MAX_BYTES = 1_000_000
const SOURCE_VERIFY_MAX_REDIRECTS = 3

export function normalizedEvidence(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[^a-z0-9\u4e00-\u9fff+#]+/g, '')
}

function stripHostBrackets(hostname: string) {
  return hostname.replace(/^\[|\]$/g, '').toLocaleLowerCase()
}

export function assertPublicDiscoverySourceUrl(raw: string) {
  if (raw.length > 4096) throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source URL exceeds its bounded size.', false)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source URL is invalid.', false)
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source must be a public http(s) URL without embedded credentials.', false)
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source uses a non-public service port.', false)
  }
  const host = stripHostBrackets(url.hostname)
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    (!host.includes('.') && !host.includes(':')) ||
    (isIP(host) !== 0 && !isPublicDiscoveryAddress(host))
  ) {
    throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source resolves to a non-public address literal or local hostname.', false)
  }
  return url
}

export function htmlTitle(value: string) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(value)?.[1]
  if (!match) return undefined
  const title = match.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return title ? title.slice(0, 400) : undefined
}

export function visibleSourceText(value: string) {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

async function readWithAbort<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Source body verification timed out.')
  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Source body verification timed out.'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([read(), aborted]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

export async function boundedResponseText(response: Response, signal: AbortSignal) {
  const length = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(length) && length > SOURCE_VERIFY_MAX_BYTES) {
    throw new WorkspaceSourceError('DISCOVERY_SOURCE_TOO_LARGE', 'Discovery source exceeds the verification size limit.', false)
  }
  if (!response.body) {
    const text = await readWithAbort(() => response.text(), signal)
    if (new TextEncoder().encode(text).byteLength > SOURCE_VERIFY_MAX_BYTES) {
      throw new WorkspaceSourceError('DISCOVERY_SOURCE_TOO_LARGE', 'Discovery source exceeds the verification size limit.', false)
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await readWithAbort(() => reader.read(), signal).catch(error => {
      void reader.cancel().catch(() => undefined)
      throw error
    })
    if (done) break
    if (!value) continue
    bytes += value.byteLength
    if (bytes > SOURCE_VERIFY_MAX_BYTES) {
      void reader.cancel().catch(() => undefined)
      throw new WorkspaceSourceError('DISCOVERY_SOURCE_TOO_LARGE', 'Discovery source exceeds the verification size limit.', false)
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

export async function fetchPublicDiscoverySource(rawUrl: string, fetchImpl: typeof fetch, allowed: (url: URL) => boolean, request?: { method: 'POST'; body: URLSearchParams }) {
  if (request && request.body.toString().length > 4096) throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Public search input exceeds its bounded request size.', false)
  let url = assertPublicDiscoverySourceUrl(rawUrl)
  for (let redirect = 0; redirect <= SOURCE_VERIFY_MAX_REDIRECTS; redirect += 1) {
    if (!allowed(url)) throw new WorkspaceSourceError('DISCOVERY_SOURCE_AUTHORITY_REQUIRED', 'Source URL left the reviewed recruiting-source boundary.', false)
    const controller = new AbortController()
    const timer = globalThis.setTimeout(() => controller.abort(), SOURCE_VERIFY_TIMEOUT_MS)
    let response: Response
    try {
      const transport = fetchImpl === globalThis.fetch ? fetchPinnedPublicDiscoverySource : fetchImpl
      response = await transport(url, {
        method: request?.method ?? 'GET',
        body: request?.body,
        redirect: 'manual',
        headers: {
          ...(request ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.7,*/*;q=0.1',
          'user-agent': 'PJSDAS-SourceVerifier/1.0',
        },
        signal: controller.signal,
      })
    } catch (caught) {
      controller.abort()
      globalThis.clearTimeout(timer)
      if (caught instanceof WorkspaceSourceError) throw caught
      throw new WorkspaceSourceError('DISCOVERY_SOURCE_UNAVAILABLE', 'Discovery source could not be fetched for independent verification.', true)
    }

    try {
    if (response.status >= 300 && response.status < 400) {
      if (request) throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'A public search POST may not redirect or change method.', false)
      const location = response.headers.get('location')
      if (!location) throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source redirect has no destination.', false)
      if (redirect >= SOURCE_VERIFY_MAX_REDIRECTS) {
        throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source exceeded the redirect limit.', false)
      }
      const destination = new URL(location, url)
      // RFC 9110 §10.2.2: a redirect without a fragment inherits the original
      // reference's fragment. SPA job identity must not disappear here.
      if (!location.includes('#')) destination.hash = url.hash
      url = assertPublicDiscoverySourceUrl(destination.toString())
      continue
    }

    if (!response.ok) {
      throw new WorkspaceSourceError(
        'DISCOVERY_SOURCE_UNAVAILABLE',
        `Discovery source verification returned HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
      )
    }

    const contentType = (response.headers.get('content-type') ?? '').toLocaleLowerCase()
    const contentEncoding = (response.headers.get('content-encoding') ?? 'identity').toLocaleLowerCase()
    if (fetchImpl === globalThis.fetch && contentEncoding !== 'identity') {
      throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Compressed source documents are not supported by this bounded public transport.', false)
    }
    if (
      contentType &&
      !contentType.startsWith('text/') &&
      !contentType.includes('application/xhtml') &&
      !contentType.includes('application/json') &&
      !contentType.includes('application/ld+json')
    ) {
      throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source is not a text document that PJSDAS can verify.', false)
    }
    return { url, raw: await boundedResponseText(response, controller.signal) }
    } finally { controller.abort(); globalThis.clearTimeout(timer) }
  }
  throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source redirect verification failed.', false)
}

