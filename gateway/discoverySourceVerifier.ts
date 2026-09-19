import { stableIngestionHash } from '../src/ingestion.js'
import type { MonitorJobObservation } from '../src/autonomousIngestion.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const SOURCE_VERIFY_TIMEOUT_MS = 8_000
const SOURCE_VERIFY_MAX_BYTES = 1_000_000
const SOURCE_VERIFY_MAX_REDIRECTS = 3

function normalizedEvidence(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[^a-z0-9\u4e00-\u9fff+#]+/g, '')
}

function companyEvidenceVariants(company: string) {
  const variants = new Set<string>()
  const raw = company.trim()
  if (raw) variants.add(normalizedEvidence(raw))
  for (const suffix of ['股份有限公司', '有限责任公司', '有限公司', '集团股份', '集团', '公司']) {
    if (raw.endsWith(suffix)) variants.add(normalizedEvidence(raw.slice(0, -suffix.length)))
  }
  const latin = raw.match(/[A-Za-z][A-Za-z0-9&.'-]*/g) ?? []
  if (latin.length) {
    variants.add(normalizedEvidence(latin.join(' ')))
    if (latin[0]!.length >= 3) variants.add(normalizedEvidence(latin[0]!))
  }
  return [...variants].filter((item) => item.length >= 2)
}

function roleEvidenceVariants(role: string) {
  const variants = new Set<string>()
  const raw = role.trim()
  if (raw) variants.add(normalizedEvidence(raw))
  const withoutQualifiers = raw
    .replace(/[（(][^）)]*(?:校招|校园|应届|届|graduate|campus)[^）)]*[）)]/gi, ' ')
    .replace(/(?:20\d{2}\s*届?|\d{2}\s*届|校园招聘|校招|应届生?|campus recruiting|graduate programme?|graduate program)/gi, ' ')
    .trim()
  if (withoutQualifiers) variants.add(normalizedEvidence(withoutQualifiers))
  return [...variants].filter((item) => item.length >= 3)
}

function stripHostBrackets(hostname: string) {
  return hostname.replace(/^\[|\]$/g, '').toLocaleLowerCase()
}

function unsafeIpv4(host: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false
  const octets = host.split('.').map(Number)
  if (octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b! >= 64 && b! <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b! >= 16 && b! <= 31) return true
  if (a === 192 && (b === 0 || b === 168)) return true
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true
  if (a === 203 && b === 0) return true
  if (a! >= 224) return true
  return false
}

function unsafeIpv6(host: string) {
  if (!host.includes(':')) return false
  const value = host.toLocaleLowerCase()
  if (value === '::' || value === '::1') return true
  if (/^(?:fc|fd)/.test(value)) return true
  if (/^fe[89ab]/.test(value)) return true
  if (value.startsWith('::ffff:')) return true
  if (value.startsWith('2001:db8:')) return true
  return false
}

export function assertPublicDiscoverySourceUrl(raw: string) {
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
    unsafeIpv4(host) ||
    unsafeIpv6(host)
  ) {
    throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source resolves to a non-public address literal or local hostname.', false)
  }
  return url
}

function htmlTitle(value: string) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(value)?.[1]
  if (!match) return undefined
  const title = match.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return title ? title.slice(0, 400) : undefined
}

function visibleSourceText(value: string) {
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

async function boundedResponseText(response: Response) {
  const length = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(length) && length > SOURCE_VERIFY_MAX_BYTES) {
    throw new WorkspaceSourceError('DISCOVERY_SOURCE_TOO_LARGE', 'Discovery source exceeds the verification size limit.', false)
  }
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > SOURCE_VERIFY_MAX_BYTES) {
      throw new WorkspaceSourceError('DISCOVERY_SOURCE_TOO_LARGE', 'Discovery source exceeds the verification size limit.', false)
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    bytes += value.byteLength
    if (bytes > SOURCE_VERIFY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
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

async function fetchPublicDiscoverySource(rawUrl: string, fetchImpl: typeof fetch) {
  let url = assertPublicDiscoverySourceUrl(rawUrl)
  for (let redirect = 0; redirect <= SOURCE_VERIFY_MAX_REDIRECTS; redirect += 1) {
    const controller = new AbortController()
    const timer = globalThis.setTimeout(() => controller.abort(), SOURCE_VERIFY_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.7,*/*;q=0.1',
          'user-agent': 'PJSDAS-SourceVerifier/1.0',
        },
        signal: controller.signal,
      })
    } catch {
      throw new WorkspaceSourceError('DISCOVERY_SOURCE_UNAVAILABLE', 'Discovery source could not be fetched for independent verification.', true)
    } finally {
      globalThis.clearTimeout(timer)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source redirect has no destination.', false)
      if (redirect >= SOURCE_VERIFY_MAX_REDIRECTS) {
        throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source exceeded the redirect limit.', false)
      }
      url = assertPublicDiscoverySourceUrl(new URL(location, url).toString())
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
    if (
      contentType &&
      !contentType.startsWith('text/') &&
      !contentType.includes('application/xhtml') &&
      !contentType.includes('application/json') &&
      !contentType.includes('application/ld+json')
    ) {
      throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source is not a text document that PJSDAS can verify.', false)
    }
    return { url, raw: await boundedResponseText(response) }
  }
  throw new WorkspaceSourceError('DISCOVERY_SOURCE_INVALID', 'Discovery source redirect verification failed.', false)
}

function literalFactPresent(evidence: string, value: string | undefined) {
  if (!value?.trim()) return false
  const needle = normalizedEvidence(value)
  return needle.length >= 2 && normalizedEvidence(evidence).includes(needle)
}

function deadlineEvidencePresent(evidence: string, raw: string | undefined) {
  if (!raw) return false
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return false
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  const variants = [
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
    `${year}年${month}月${day}日`,
    `${month}月${day}日`,
  ].map(normalizedEvidence)
  const haystack = normalizedEvidence(evidence)
  return variants.some((item) => item && haystack.includes(item))
}

function closedPostingEvidence(evidence: string) {
  return /(职位已关闭|岗位已关闭|招聘已结束|职位已下线|岗位已下线|已停止招聘|position\s+(?:is\s+)?(?:closed|filled)|job\s+(?:is\s+)?no\s+longer\s+available|posting\s+(?:has\s+)?expired)/i.test(evidence)
}

export async function verifyDiscoverySourceObservation(
  observation: MonitorJobObservation,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? new Date()
  try {
    const fetched = await fetchPublicDiscoverySource(observation.sourceUrl, fetchImpl)
    const visible = visibleSourceText(fetched.raw)
    const title = htmlTitle(fetched.raw)
    const evidence = `${title ?? ''} ${visible} ${fetched.url.hostname} ${fetched.url.pathname}`
    const normalized = normalizedEvidence(evidence)
    const companyVerified = companyEvidenceVariants(observation.company).some((item) => normalized.includes(item))
    const roleVerified = roleEvidenceVariants(observation.role).some((item) => normalized.includes(item))
    if (!companyVerified || !roleVerified) {
      return {
        ...observation,
        sourceVerification: 'unverified' as const,
        sourceVerificationReason: !companyVerified && !roleVerified
          ? 'fetched page did not independently corroborate company or role identity'
          : !companyVerified
            ? 'fetched page did not independently corroborate company identity'
            : 'fetched page did not independently corroborate role identity',
      }
    }

    const verifiedAt = now.toISOString()
    const canonicalSource = fetched.url.toString()
    return {
      ...observation,
      sourceRecordId: `verified:${stableIngestionHash(`${canonicalSource}|${observation.company}|${observation.role}`)}`,
      sourceUrl: canonicalSource,
      sourceTitle: title ?? `${fetched.url.hostname}${fetched.url.pathname}`.slice(0, 400),
      location: literalFactPresent(evidence, observation.location) ? observation.location : undefined,
      deadline: deadlineEvidencePresent(evidence, observation.deadline) ? observation.deadline : undefined,
      compensationText: literalFactPresent(evidence, observation.compensationText) ? observation.compensationText : undefined,
      postingStatus: observation.postingStatus === 'closed' && closedPostingEvidence(evidence)
        ? 'closed' as const
        : 'unknown' as const,
      discoveredAt: verifiedAt,
      sourceVerification: 'verified' as const,
      sourceVerifiedAt: verifiedAt,
      sourceVerificationReason: undefined,
    }
  } catch (caught) {
    const reason = caught instanceof WorkspaceSourceError
      ? `${caught.code}: ${caught.message}`
      : 'DISCOVERY_SOURCE_UNAVAILABLE: source verification failed'
    return {
      ...observation,
      sourceVerification: 'unverified' as const,
      sourceVerificationReason: reason.slice(0, 500),
    }
  }
}


