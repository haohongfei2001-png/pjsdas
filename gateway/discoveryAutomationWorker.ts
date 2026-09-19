import * as z from 'zod/v4'
import { getDiscoveryContext } from '../src/ai/readLayer.js'
import { buildContinuousDiscoverySummary } from '../src/continuousDiscovery.js'
import {
  buildDiscoveryAutomationPlan,
  type DiscoveryAutomationSourcePlan,
} from '../src/discoveryAutomation.js'
import { decisionRulesForSnapshot } from '../src/decisionRules.js'
import {
  discoveryProfileForSnapshot,
  isDiscoveryProfileConfigured,
} from '../src/discoveryProfile.js'
import { applyMonitorIngestionHardened } from '../src/ingestionHardening.js'
import { stableIngestionHash } from '../src/ingestion.js'
import {
  effectiveSourceRegistry,
  type IngestionSourcePolicy,
} from '../src/sourceRegistry.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
import { createDriveWorkspaceSource } from './driveWorkspaceSource.js'
import { createTransactionalWorkspaceSource } from './transactionalWorkspaceSource.js'
import { refreshGoogleAccessToken } from './googleOAuthTokens.js'
import { decryptSecret } from './tokenCrypto.js'
import type { DiscoveryAutomationBinding } from './automationConnectionStore.js'
import { PJSDAS_SUPABASE_URL } from './supabaseProject.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

const DEFAULT_MODEL = 'perplexity/sonar'
const MAX_EXISTING_IDENTITIES = 100
const MAX_RECENT_REJECTIONS = 40
const SOURCE_VERIFY_TIMEOUT_MS = 8_000
const SOURCE_VERIFY_MAX_BYTES = 1_000_000
const SOURCE_VERIFY_MAX_REDIRECTS = 3

const confidenceSchema = z.enum(['high', 'medium', 'low'])
const roleTypeSchema = z.enum(['core', 'backup', 'reach', 'lottery', 'practice'])
const postingStatusSchema = z.enum(['open', 'closed', 'unknown'])
const isoString = z.string().min(1).refine((value) => !Number.isNaN(new Date(value).getTime()), 'Must be a valid date/time.')

const observationSchema = z.object({
  sourceRecordId: z.string().trim().min(1).max(500),
  company: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(260),
  sourceUrl: z.string().url().max(2_000),
  sourceTitle: z.string().trim().min(1).max(400),
  location: z.string().trim().max(240).optional(),
  deadline: isoString.optional(),
  compensationText: z.string().trim().max(600).optional(),
  rationale: z.string().trim().min(1).max(1_600),
  roleType: roleTypeSchema,
  opportunityValue: z.number().min(0).max(100),
  fitScore: z.number().min(0).max(100),
  fitConfidence: confidenceSchema,
  opportunityValueConfidence: confidenceSchema,
  postingStatus: postingStatusSchema.optional(),
  discoveredAt: isoString.optional(),
}).strict()

export type DiscoveryModelObservation = z.infer<typeof observationSchema>

const discoveryResponseSchema = z.object({
  observations: z.array(observationSchema).max(25),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>()
  for (const [index, observation] of value.observations.entries()) {
    const key = observation.sourceRecordId.toLocaleLowerCase()
    if (ids.has(key)) {
      context.addIssue({ code: 'custom', message: `Duplicate sourceRecordId at observations[${index}].` })
    }
    ids.add(key)
  }
})

export interface DiscoveryGenerateTextInput {
  model: string
  system: string
  prompt: string
  temperature: number
  maxOutputTokens: number
}

export type DiscoveryGenerateText = (input: DiscoveryGenerateTextInput) => Promise<{ text: string }>

export interface DiscoveryAiOptions {
  model?: string
  generateTextImpl?: DiscoveryGenerateText
}

export interface DiscoveryAutomationRunResult {
  checkedAt: string
  configured: boolean
  dueSourceCount: number
  completedSourceCount: number
  skippedSourceCount: number
  receivedCount: number
  accountedCount: number
  createdCount: number
  touchedCount: number
  unresolvedCount: number
}

function parseJsonObject(text: string) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) throw new WorkspaceSourceError('DISCOVERY_MODEL_INVALID', 'Discovery model returned no JSON object.', true)
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown
    } catch {
      throw new WorkspaceSourceError('DISCOVERY_MODEL_INVALID', 'Discovery model returned malformed JSON.', true)
    }
  }
}

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
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length)
    return unsafeIpv4(mapped)
  }
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
  observation: DiscoveryModelObservation,
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

function sourcePolicy(sourceRun: DiscoveryAutomationSourcePlan): IngestionSourcePolicy {
  return {
    version: 1,
    enabled: true,
    label: sourceRun.label,
    cadenceMinutes: sourceRun.cadenceMinutes,
    freshnessSlaMinutes: sourceRun.freshnessSlaMinutes,
  }
}

function latestSourceCompletion(snapshot: PJSDASSnapshot, sourceId: string) {
  return (snapshot.data.timeline ?? [])
    .flatMap((item) => item.ingestionRun?.sourceKind === 'gpt_monitor' && item.ingestionRun.sourceId === sourceId ? [item.ingestionRun.completedAt] : [])
    .sort((a, b) => b.localeCompare(a))[0]
}

function sourceIsDue(snapshot: PJSDASSnapshot, sourceRun: DiscoveryAutomationSourcePlan, now: Date, force: boolean) {
  if (force) return true
  const completedAt = latestSourceCompletion(snapshot, sourceRun.sourceId)
  if (!completedAt) return true
  const completed = new Date(completedAt).getTime()
  if (!Number.isFinite(completed)) return true
  return now.getTime() - completed >= sourceRun.cadenceMinutes * 60_000
}

function stableRunId(sourceRun: DiscoveryAutomationSourcePlan, now: Date) {
  const cadenceMs = sourceRun.cadenceMinutes * 60_000
  const bucket = Math.floor(now.getTime() / cadenceMs)
  return `server-discovery:${sourceRun.sourceId}:${bucket}`
}

function boundedModelContext(snapshot: PJSDASSnapshot, now: Date) {
  const discovery = getDiscoveryContext(snapshot, { now })
  const rules = decisionRulesForSnapshot(snapshot.data.decisionRules)
  return {
    profile: discovery.profile,
    decisionWeights: rules.weights,
    existingOpportunities: discovery.existingOpportunities.slice(0, MAX_EXISTING_IDENTITIES),
    recentlyRejected: discovery.recentlyRejected.slice(0, MAX_RECENT_REJECTIONS),
  }
}

function buildPrompt(snapshot: PJSDASSnapshot, sourceRun: DiscoveryAutomationSourcePlan, executionRules: string[], incrementalSince: string | undefined, now: Date) {
  const context = boundedModelContext(snapshot, now)
  return [
    'You are the bounded public-web discovery interpreter for PJSDAS.',
    'Run live web search for this one source run and return ONLY a JSON object with shape {"observations":[...]}. Do not use Markdown.',
    'Every observation must be supported by a public job/recruiting source URL. Prefer the employer official career/campus-recruiting page or the authoritative ATS posting. Never use a search-result page, social repost, or model-generated URL as sourceUrl when an authoritative posting is available.',
    'Keep unknown facts omitted. Never infer a deadline, location, salary, posting status, qualification, or source fact that the page does not support.',
    'sourceRecordId must be stable across reruns: use a source-native posting/job id when visible; otherwise use the canonical source URL itself.',
    'fitScore and opportunityValue are bounded interpretations for the existing PJSDAS ingestion contract, not source facts. Score conservatively from the explicit profile and evidence. Use medium/low confidence whenever evidence is incomplete. 50 is an appropriate neutral value when attractiveness cannot be established. Do not inflate scores to pass thresholds.',
    'roleType must be one of core, backup, reach, lottery, practice and should reflect the explicit profile rather than hidden preferences.',
    'For refreshTargets, verify the exact canonicalSourceUrl first. A closed/expired posting may be returned with postingStatus="closed" so PJSDAS can update factual posting evidence; this must never be interpreted as the user being rejected or their recruiting process closing.',
    `Current time: ${now.toISOString()}`,
    incrementalSince ? `Normal incremental lower bound: ${incrementalSince}` : 'No durable baseline exists; keep this first pass bounded.',
    `Source run: ${JSON.stringify(sourceRun)}`,
    `Execution rules: ${JSON.stringify(executionRules)}`,
    `Canonical user-controlled discovery context: ${JSON.stringify(context)}`,
    `Return at most ${sourceRun.maxObservations} observations. Each observation requires sourceRecordId, company, role, sourceUrl, sourceTitle, rationale, roleType, opportunityValue, fitScore, fitConfidence, opportunityValueConfidence. Optional fields: location, deadline, compensationText, postingStatus, discoveredAt.`,
    'If no qualifying or verifiable observations are found, return exactly {"observations":[]}.',
  ].join('\n\n')
}

function modelStatusCode(caught: unknown) {
  if (!caught || typeof caught !== 'object') return undefined
  const direct = (caught as { statusCode?: unknown }).statusCode
  if (typeof direct === 'number') return direct
  const responseStatus = (caught as { response?: { status?: unknown } }).response?.status
  return typeof responseStatus === 'number' ? responseStatus : undefined
}

function safeGatewayRuleId(value: unknown) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return /^[A-Za-z0-9_-]{1,160}$/.test(trimmed) ? trimmed : undefined
}

function gatewayErrorDetails(caught: unknown) {
  if (!caught || typeof caught !== 'object') return { type: undefined, message: undefined, ruleId: undefined }
  const candidate = caught as {
    type?: unknown
    message?: unknown
    ruleId?: unknown
    responseBody?: unknown
    data?: unknown
  }
  const direct = {
    type: typeof candidate.type === 'string' ? candidate.type : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
    ruleId: safeGatewayRuleId(candidate.ruleId),
  }
  let payload: unknown = candidate.data
  if (typeof candidate.responseBody === 'string') {
    try {
      payload = JSON.parse(candidate.responseBody) as unknown
    } catch {
      // Non-JSON provider bodies are intentionally not surfaced.
    }
  }
  if (!payload || typeof payload !== 'object') return direct
  const root = payload as Record<string, unknown>
  const nested = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root
  const param = nested.param && typeof nested.param === 'object' ? nested.param as Record<string, unknown> : undefined
  return {
    type: typeof nested.type === 'string' ? nested.type : direct.type,
    message: typeof nested.message === 'string'
      ? nested.message
      : typeof root.error === 'string'
        ? root.error
        : direct.message,
    ruleId: safeGatewayRuleId(param?.ruleId) ?? direct.ruleId,
  }
}

function throwModelError(caught: unknown): never {
  if (caught instanceof WorkspaceSourceError) throw caught
  const status = modelStatusCode(caught)
  const details = gatewayErrorDetails(caught)
  const message = details.message?.toLocaleLowerCase() ?? ''
  if (status === 401) {
    throw new WorkspaceSourceError('DISCOVERY_MODEL_AUTH_REQUIRED', 'Vercel AI Gateway rejected discovery-worker authentication.', false)
  }
  if (status === 402) {
    if (details.type === 'quota_for_entity_exceeded') {
      throw new WorkspaceSourceError('DISCOVERY_MODEL_QUOTA_EXCEEDED', 'A Vercel AI Gateway budget or quota blocks background discovery.', false)
    }
    throw new WorkspaceSourceError('DISCOVERY_MODEL_CREDITS_REQUIRED', 'Vercel AI Gateway has no positive credit balance for background discovery.', false)
  }
  if (status === 403) {
    if (details.type === 'customer_verification_required') {
      throw new WorkspaceSourceError('DISCOVERY_MODEL_CUSTOMER_VERIFICATION_REQUIRED', 'Vercel AI Gateway requires team payment-method verification before background discovery can use Gateway credits.', false)
    }
    if (message.includes('free tier')) {
      throw new WorkspaceSourceError('DISCOVERY_MODEL_CREDITS_REQUIRED', 'The selected discovery model is not available on the current Vercel AI Gateway free tier.', false)
    }
    if (details.type === 'no_providers_available' || message.includes('allowlist') || message.includes('not allowed') || message.includes('restriction') || message.includes('restricted access')) {
      throw new WorkspaceSourceError('DISCOVERY_MODEL_RESTRICTED', 'Vercel AI Gateway team restrictions block the selected discovery model or provider.', false)
    }
    if (details.type === 'forbidden') {
      const ruleSuffix = details.ruleId ? ` (routing rule ${details.ruleId})` : ''
      throw new WorkspaceSourceError(
        'DISCOVERY_MODEL_POLICY_FORBIDDEN',
        `Vercel AI Gateway routing policy denied the discovery-model request${ruleSuffix}.`,
        false,
      )
    }
    throw new WorkspaceSourceError('DISCOVERY_MODEL_FORBIDDEN', "Vercel AI Gateway denied this project's discovery-model request.", false)
  }
  if (status === 429 || (typeof status === 'number' && status >= 500)) {
    throw new WorkspaceSourceError('DISCOVERY_MODEL_UNAVAILABLE', `Vercel AI Gateway is temporarily unavailable${status ? ` (HTTP ${status})` : ''}.`, true)
  }
  if (typeof status === 'number') {
    throw new WorkspaceSourceError('DISCOVERY_MODEL_FAILED', `Vercel AI Gateway discovery request failed (HTTP ${status}).`, false)
  }
  throw new WorkspaceSourceError('DISCOVERY_MODEL_UNAVAILABLE', 'Vercel AI Gateway is temporarily unavailable.', true)
}

async function defaultGenerateText(input: DiscoveryGenerateTextInput) {
  const { generateText } = await import('ai')
  return generateText(input)
}

async function aiGatewayText(prompt: string, options: DiscoveryAiOptions) {
  const generate = options.generateTextImpl ?? defaultGenerateText
  let content = ''
  try {
    const result = await generate({
      model: options.model?.trim() || DEFAULT_MODEL,
      system: 'You perform citation-grounded public job discovery and obey strict JSON output contracts.',
      prompt,
      temperature: 0.1,
      maxOutputTokens: 5_000,
    })
    content = result.text?.trim() ?? ''
  } catch (caught) {
    throwModelError(caught)
  }
  if (!content) throw new WorkspaceSourceError('DISCOVERY_MODEL_INVALID', 'Discovery model returned no usable content.', true)
  return content
}

export async function discoverSourceRun(snapshot: PJSDASSnapshot, sourceRun: DiscoveryAutomationSourcePlan, input: {
  executionRules: string[]
  incrementalSince?: string
  now: Date
  ai: DiscoveryAiOptions
  fetchImpl?: typeof fetch
}) {
  const content = await aiGatewayText(buildPrompt(snapshot, sourceRun, input.executionRules, input.incrementalSince, input.now), input.ai)
  const parsed = discoveryResponseSchema.safeParse(parseJsonObject(content))
  if (!parsed.success) {
    throw new WorkspaceSourceError('DISCOVERY_MODEL_INVALID', parsed.error.issues[0]?.message ?? 'Discovery model output violated the PJSDAS schema.', true)
  }
  if (parsed.data.observations.length > sourceRun.maxObservations) {
    throw new WorkspaceSourceError('DISCOVERY_MODEL_INVALID', `Discovery model returned more than ${sourceRun.maxObservations} observations.`, true)
  }
  return Promise.all(parsed.data.observations.map((observation) =>
    verifyDiscoverySourceObservation(observation, { fetchImpl: input.fetchImpl, now: input.now }),
  ))
}

function buildPlan(snapshot: PJSDASSnapshot, now: Date) {
  const continuousDiscovery = buildContinuousDiscoverySummary({
    changeSets: snapshot.data.changeSets ?? [],
    opportunities: snapshot.data.opportunities,
    inbox: snapshot.data.discoveryInbox ?? [],
    now,
  })
  return buildDiscoveryAutomationPlan({
    profile: snapshot.data.discoveryProfile,
    continuousDiscovery,
    sources: effectiveSourceRegistry(snapshot.data.timeline),
  })
}

async function applySourceRun(source: WorkspaceSource, sourceRun: DiscoveryAutomationSourcePlan, observations: z.infer<typeof observationSchema>[], now: Date, force: boolean) {
  const runId = stableRunId(sourceRun, now)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const workspace = await source.read()
    const currentPlan = buildPlan(workspace.snapshot, now)
    const currentSourceRun = currentPlan.sourceRuns.find((item) => item.sourceId === sourceRun.sourceId)
    if (!currentSourceRun) return { status: 'skipped' as const, reason: 'source-disabled' }
    if (!sourceIsDue(workspace.snapshot, currentSourceRun, now, force)) return { status: 'skipped' as const, reason: 'not-due' }

    const result = applyMonitorIngestionHardened(workspace.snapshot, {
      runId,
      sourceId: currentSourceRun.sourceId,
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      sourcePolicy: sourcePolicy(currentSourceRun),
      observations,
    })
    if (result.alreadyApplied) {
      return { status: 'success' as const, result, workspaceVersion: workspace.context.workspaceVersion }
    }
    try {
      const writable = requireWritableWorkspaceSource(source)
      const written = await writable.write({
        snapshot: result.snapshot,
        expectedWorkspaceVersion: workspace.context.workspaceVersion,
        updatedByDevice: `server-discovery:${currentSourceRun.sourceId}`,
      })
      return { status: 'success' as const, result, workspaceVersion: written.context.workspaceVersion }
    } catch (caught) {
      if (!(caught instanceof WorkspaceSourceError) || caught.code !== 'WORKSPACE_CONFLICT' || attempt > 0) throw caught
    }
  }
  throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'PJSDAS workspace changed while background discovery was writing.', true)
}

export async function runDiscoveryAutomationForBinding(options: {
  binding: DiscoveryAutomationBinding
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  aiGatewayModel?: string
  generateTextImpl?: DiscoveryGenerateText
  fetchImpl?: typeof fetch
  now?: () => Date
  force?: boolean
}): Promise<DiscoveryAutomationRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now?.() ?? new Date()
  const checkedAt = now.toISOString()
  const transactionalAuthority = process.env.PJSDAS_CONNECTED_AUTHORITY?.trim() === 'transactional'
  let source: WorkspaceSource
  if (transactionalAuthority) {
    source = createTransactionalWorkspaceSource({
      userId: options.binding.userId,
      supabaseUrl: PJSDAS_SUPABASE_URL,
      serviceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
      principalKind: 'automation',
      sourceId: 'discovery:server',
      timezone: 'Asia/Shanghai',
      fetchImpl,
    })
  } else {
    const refreshToken = await decryptSecret(options.binding.refreshTokenCiphertext, options.tokenEncryptionKey)
    const accessToken = await refreshGoogleAccessToken(refreshToken, {
      clientId: options.googleClientId,
      clientSecret: options.googleClientSecret,
      fetchImpl,
    })
    source = createDriveWorkspaceSource({
      getAccessToken: () => accessToken,
      fetchImpl,
      timezone: 'Asia/Shanghai',
    })
  }
  const initial = await source.read()
  const profile = discoveryProfileForSnapshot(initial.snapshot.data.discoveryProfile)
  if (!isDiscoveryProfileConfigured(profile)) {
    return {
      checkedAt,
      configured: false,
      dueSourceCount: 0,
      completedSourceCount: 0,
      skippedSourceCount: 0,
      receivedCount: 0,
      accountedCount: 0,
      createdCount: 0,
      touchedCount: 0,
      unresolvedCount: 0,
    }
  }

  const plan = buildPlan(initial.snapshot, now)
  const dueSources = plan.sourceRuns.filter((item) => sourceIsDue(initial.snapshot, item, now, Boolean(options.force)))
  if (dueSources.length === 0) {
    return {
      checkedAt,
      configured: true,
      dueSourceCount: 0,
      completedSourceCount: 0,
      skippedSourceCount: 0,
      receivedCount: 0,
      accountedCount: 0,
      createdCount: 0,
      touchedCount: 0,
      unresolvedCount: 0,
    }
  }

  const discovered = await Promise.all(dueSources.map(async (sourceRun) => ({
    sourceRun,
    observations: await discoverSourceRun(initial.snapshot, sourceRun, {
      executionRules: plan.executionRules,
      incrementalSince: plan.incrementalSince,
      now,
      ai: {
        model: options.aiGatewayModel,
        generateTextImpl: options.generateTextImpl,
      },
      fetchImpl,
    }),
  })))

  let completedSourceCount = 0
  let skippedSourceCount = 0
  let receivedCount = 0
  let accountedCount = 0
  let createdCount = 0
  const touched = new Set<string>()
  let unresolvedCount = 0

  for (const item of discovered) {
    const applied = await applySourceRun(source, item.sourceRun, item.observations, now, Boolean(options.force))
    if (applied.status === 'skipped') {
      skippedSourceCount += 1
      continue
    }
    completedSourceCount += 1
    receivedCount += applied.result.run.receivedCount
    accountedCount += applied.result.run.accountedCount
    createdCount += applied.result.createdOpportunityIds.length
    for (const id of applied.result.touchedOpportunityIds) touched.add(id)
    unresolvedCount += applied.result.run.outcomes.unresolved ?? 0
  }

  return {
    checkedAt,
    configured: true,
    dueSourceCount: dueSources.length,
    completedSourceCount,
    skippedSourceCount,
    receivedCount,
    accountedCount,
    createdCount,
    touchedCount: touched.size,
    unresolvedCount,
  }
}

export async function probeDiscoveryAiGateway(options: DiscoveryAiOptions) {
  const content = await aiGatewayText('Return only this JSON object with no Markdown: {"observations":[]}', options)
  const parsed = discoveryResponseSchema.safeParse(parseJsonObject(content))
  if (!parsed.success || parsed.data.observations.length !== 0) {
    throw new WorkspaceSourceError('DISCOVERY_MODEL_INVALID', 'Discovery model probe did not honor the zero-observation JSON contract.', true)
  }
  return { model: options.model?.trim() || DEFAULT_MODEL, ok: true }
}
