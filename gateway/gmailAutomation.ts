import { aggregateHistoryLag, type GmailExecutionMetrics } from './gmailExecutionMetrics.js'
import { resolveSourceTemporal } from '../src/sourceTemporal.js'
import { parseRecruitingNotification } from '../src/notificationParser.js'
import { stageForProcessEvent } from '../src/processEvents.js'
import {
  applyGmailIngestionHardened,
  type HardenedGmailMessageObservation,
} from '../src/ingestionHardening.js'
import { bootstrapPolicyFor } from '../src/sourceRegistry.js'
import { alreadyIngested, stableIngestionHash } from '../src/ingestion.js'
import { applyGmailSemanticBatch, type GmailSemanticRecord } from '../src/gmailSemanticIntake.js'
import type { Opportunity, ProcessEventType, SemanticCandidate } from '../src/model.js'
import { createDriveWorkspaceSource } from './driveWorkspaceSource.js'
import { createTransactionalWorkspaceSource } from './transactionalWorkspaceSource.js'
import { refreshGoogleAccessToken } from './googleOAuthTokens.js'
import { decryptSecret } from './tokenCrypto.js'
import { GMAIL_READONLY_SCOPE, type GmailAutomationBinding } from './automationConnectionStore.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError } from './workspaceSource.js'
import { PJSDAS_SUPABASE_URL } from './supabaseProject.js'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GMAIL_SOURCE_ID = 'gmail:primary'
const GMAIL_PROVIDER_PAGE_SIZE = 100
const LEGACY_MAX_MESSAGES_PER_RUN = 100
export const UU06_MAX_MESSAGES_PER_RUN = 20
export const INITIAL_LOOKBACK_DAYS = 90

interface GmailHeader { name?: string; value?: string }
interface GmailPartBody { data?: string }
interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: GmailPartBody
  parts?: GmailPart[]
}
interface GmailMessage {
  id?: string
  threadId?: string
  internalDate?: string
  snippet?: string
  labelIds?: string[]
  payload?: GmailPart
}

interface GmailProfile { historyId?: string }
interface GmailMessageList { messages?: Array<{ id?: string }>; nextPageToken?: string }
interface GmailHistoryList {
  historyId?: string
  nextPageToken?: string
  history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>
}

export interface GmailAutomationContinuation {
  mode: 'history' | 'fallback'
  pageToken?: string
  pendingHistoryId: string
  pendingMessageIds: string[]
}

export interface GmailAutomationFetchResult {
  messages: GmailMessage[]
  nextHistoryId?: string
  continuation?: GmailAutomationContinuation
  coverageComplete: boolean
  usedFallbackScan: boolean
  recoveryGapReason?: string
}

export interface GmailAutomationRunResult {
  metrics?: GmailExecutionMetrics
  userId: string
  checkedAt: string
  nextHistoryId?: string
  continuation?: GmailAutomationContinuation
  coverageComplete: boolean
  recoveryGapDetected: boolean
  receivedCount: number
  accountedCount: number
  unresolvedCount: number
  alreadyApplied: boolean
  workspaceVersion?: string
  usedFallbackScan: boolean
}

function cleanText(value: string | undefined) {
  return (value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim()
}

function header(part: GmailPart | undefined, name: string) {
  return cleanText(part?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value)
}

function decodeBase64Url(value: string | undefined) {
  if (!value) return ''
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

function stripHtml(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
}

function messageBodyText(part: GmailPart | undefined): string {
  if (!part) return ''
  const plain: string[] = []
  const html: string[] = []
  const visit = (item: GmailPart) => {
    if (item.filename) return
    const decoded = decodeBase64Url(item.body?.data)
    if (decoded) {
      if (item.mimeType?.toLowerCase().startsWith('text/plain')) plain.push(decoded)
      else if (item.mimeType?.toLowerCase().startsWith('text/html')) html.push(stripHtml(decoded))
    }
    for (const child of item.parts ?? []) visit(child)
  }
  visit(part)
  return (plain.length ? plain : html).join('\n').replace(/\u0000/g, '').trim().slice(0, 12_000)
}

type GoogleApiErrorPayload = {
  error?: {
    errors?: Array<{ reason?: string }>
    details?: Array<{ reason?: string }>
    status?: string
  }
}

async function gmailForbiddenError(response: Response) {
  const payload = await response.clone().json().catch(() => undefined) as GoogleApiErrorPayload | undefined
  const reasons = new Set([
    ...(payload?.error?.errors ?? []).flatMap((item) => item.reason ? [item.reason] : []),
    ...(payload?.error?.details ?? []).flatMap((item) => item.reason ? [item.reason] : []),
  ])

  if (reasons.has('accessNotConfigured') || reasons.has('SERVICE_DISABLED')) {
    return new WorkspaceSourceError(
      'GOOGLE_GMAIL_API_DISABLED',
      'The Gmail API is not enabled for the Google Cloud project used by PJSDAS.',
      false,
    )
  }
  if (reasons.has('insufficientPermissions') || reasons.has('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
    return new WorkspaceSourceError(
      'GOOGLE_GMAIL_SCOPE_MISSING',
      'The stored Google authorization does not grant Gmail read-only access. Reconnect Google and enable recruiting-email tracking.',
      false,
    )
  }
  if (['dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'RESOURCE_EXHAUSTED']
    .some((reason) => reasons.has(reason))) {
    return new WorkspaceSourceError('GMAIL_UNAVAILABLE', 'Gmail API quota is temporarily unavailable.', true)
  }
  return new WorkspaceSourceError('GOOGLE_GMAIL_FORBIDDEN', 'Google denied Gmail read access for PJSDAS.', false)
}

async function gmailFetch(fetchImpl: typeof fetch, accessToken: string, path: string) {
  let response: Response
  try {
    response = await fetchImpl(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    })
  } catch {
    throw new WorkspaceSourceError('GMAIL_UNAVAILABLE', 'Gmail is temporarily unavailable.', true)
  }
  if (response.status === 401) throw new WorkspaceSourceError('GOOGLE_AUTH_EXPIRED', 'Google authorization is no longer valid. Reconnect Google to PJSDAS.', false)
  if (response.status === 403) throw await gmailForbiddenError(response)
  if (response.status === 429 || response.status >= 500) throw new WorkspaceSourceError('GMAIL_UNAVAILABLE', `Gmail is temporarily unavailable (HTTP ${response.status}).`, true)
  return response
}

async function gmailJson<T>(fetchImpl: typeof fetch, accessToken: string, path: string): Promise<T> {
  const response = await gmailFetch(fetchImpl, accessToken, path)
  if (!response.ok) throw new WorkspaceSourceError('GMAIL_REQUEST_FAILED', `Gmail request failed (HTTP ${response.status}).`, false)
  try {
    return await response.json() as T
  } catch {
    throw new WorkspaceSourceError('GMAIL_RESPONSE_INVALID', 'Gmail returned malformed JSON.', true)
  }
}

async function gmailProfile(fetchImpl: typeof fetch, accessToken: string) {
  const profile = await gmailJson<GmailProfile>(fetchImpl, accessToken, '/profile')
  if (!profile.historyId) throw new WorkspaceSourceError('GMAIL_RESPONSE_INVALID', 'Gmail profile did not include a history cursor.', true)
  return profile.historyId
}

async function initialMessagePage(
  fetchImpl: typeof fetch,
  accessToken: string,
  pageToken?: string,
  now = new Date(),
  expanded = false,
) {
  // Persist the fixed query inside the existing opaque continuation token, so a
  // multi-day recovery does not shift its lower boundary while paging.
  let query = `after:${Math.floor(now.getTime() / 1000) - INITIAL_LOOKBACK_DAYS * 86400} -in:spam -in:trash`
  let providerPageToken = pageToken
  if (expanded && pageToken?.startsWith('uu06:')) {
    const decoded = JSON.parse(decodeURIComponent(pageToken.slice(5))) as { query: string; token: string }
    if (!/^after:\d+ -in:spam -in:trash$/.test(decoded.query) || !decoded.token) throw new Error('Invalid Gmail backfill continuation.')
    query = decoded.query
    providerPageToken = decoded.token
  }
  const params = new URLSearchParams({
    maxResults: String(GMAIL_PROVIDER_PAGE_SIZE),
    q: expanded ? query : 'newer_than:7d -in:spam -in:trash',
    ...(!expanded ? { labelIds: 'INBOX' } : {}),
  })
  if (providerPageToken) params.set('pageToken', providerPageToken)
  const payload = await gmailJson<GmailMessageList>(fetchImpl, accessToken, `/messages?${params.toString()}`)
  const ids = [...new Set((payload.messages ?? []).flatMap((item) => item.id ? [item.id] : []))]
  return { ids, nextPageToken: expanded && payload.nextPageToken ? `uu06:${encodeURIComponent(JSON.stringify({ query, token: payload.nextPageToken }))}` : payload.nextPageToken }
}

async function historyMessagePage(
  fetchImpl: typeof fetch,
  accessToken: string,
  startHistoryId: string,
  pageToken?: string,
  expanded = false,
) {
  const params = new URLSearchParams({
    startHistoryId,
    historyTypes: 'messageAdded',
    ...(!expanded ? { labelId: 'INBOX' } : {}),
    maxResults: String(GMAIL_PROVIDER_PAGE_SIZE),
  })
  if (pageToken) params.set('pageToken', pageToken)
  const response = await gmailFetch(fetchImpl, accessToken, `/history?${params.toString()}`)
  if (response.status === 404) {
    return { expired: true as const, ids: [], historyId: undefined, nextPageToken: undefined }
  }
  if (!response.ok) throw new WorkspaceSourceError('GMAIL_REQUEST_FAILED', `Gmail history request failed (HTTP ${response.status}).`, false)
  const payload = await response.json().catch(() => undefined) as GmailHistoryList | undefined
  if (!payload) throw new WorkspaceSourceError('GMAIL_RESPONSE_INVALID', 'Gmail history response was invalid.', true)
  const ids: string[] = []
  for (const history of payload.history ?? []) {
    for (const added of history.messagesAdded ?? []) if (added.message?.id) ids.push(added.message.id)
  }
  return {
    expired: false as const,
    ids: [...new Set(ids)],
    historyId: payload.historyId,
    nextPageToken: payload.nextPageToken,
  }
}

function boundedPage(
  ids: string[],
  input: {
    mode: GmailAutomationContinuation['mode']
    pageToken?: string
    pendingHistoryId: string
  },
  limit = LEGACY_MAX_MESSAGES_PER_RUN,
) {
  const selected = ids.slice(0, limit)
  const pendingMessageIds = ids.slice(limit)
  const coverageComplete = pendingMessageIds.length === 0 && !input.pageToken
  return {
    selected,
    coverageComplete,
    nextHistoryId: coverageComplete ? input.pendingHistoryId : undefined,
    continuation: coverageComplete ? undefined : {
      mode: input.mode,
      pageToken: input.pageToken,
      pendingHistoryId: input.pendingHistoryId,
      pendingMessageIds,
    } satisfies GmailAutomationContinuation,
  }
}

async function fetchMessages(fetchImpl: typeof fetch, accessToken: string, ids: string[]) {
  const messages: GmailMessage[] = []
  for (let index = 0; index < ids.length; index += 5) {
    const batch = ids.slice(index, index + 5)
    const settled = await Promise.all(batch.map((id) => gmailJson<GmailMessage>(
      fetchImpl,
      accessToken,
      `/messages/${encodeURIComponent(id)}?format=full`,
    )))
    messages.push(...settled)
  }
  return messages
}

export async function fetchGmailAutomationBatch(options: {
  accessToken: string
  startHistoryId?: string
  continuation?: GmailAutomationContinuation
  fetchImpl?: typeof fetch
  now?: Date
  coverage?: 'legacy' | 'uu06'
}): Promise<GmailAutomationFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const currentHistoryId = await gmailProfile(fetchImpl, options.accessToken)
  const previous = options.continuation

  if (previous?.pendingMessageIds.length) {
    const bounded = boundedPage(previous.pendingMessageIds, {
      mode: previous.mode,
      pageToken: previous.pageToken,
      pendingHistoryId: previous.pendingHistoryId,
    }, options.coverage === 'uu06' ? UU06_MAX_MESSAGES_PER_RUN : LEGACY_MAX_MESSAGES_PER_RUN)
    return {
      messages: await fetchMessages(fetchImpl, options.accessToken, bounded.selected),
      nextHistoryId: bounded.nextHistoryId,
      continuation: bounded.continuation,
      coverageComplete: bounded.coverageComplete,
      usedFallbackScan: previous.mode === 'fallback',
    }
  }

  let mode: GmailAutomationContinuation['mode']
  let ids: string[]
  let nextPageToken: string | undefined
  let pendingHistoryId: string
  let usedFallbackScan = false
  let recoveryGapReason: string | undefined

  const fallbackPage = async (pageToken?: string, pending = currentHistoryId) => {
    const page = await initialMessagePage(fetchImpl, options.accessToken, pageToken, options.now, options.coverage === 'uu06')
    mode = 'fallback'
    ids = page.ids
    nextPageToken = page.nextPageToken
    pendingHistoryId = pending
    usedFallbackScan = true
  }

  if (previous?.mode === 'fallback') {
    await fallbackPage(previous.pageToken, previous.pendingHistoryId)
  } else if (previous?.mode === 'history' && options.startHistoryId) {
    const page = await historyMessagePage(fetchImpl, options.accessToken, options.startHistoryId, previous.pageToken, options.coverage === 'uu06')
    if (page.expired) {
      recoveryGapReason = `Gmail history cursor ${options.startHistoryId} expired before PJSDAS could prove complete consumption; bounded recent recovery cannot prove older mailbox coverage.`
      await fallbackPage(undefined, currentHistoryId)
    } else {
      mode = 'history'
      ids = page.ids
      nextPageToken = page.nextPageToken
      pendingHistoryId = previous.pendingHistoryId
    }
  } else if (options.startHistoryId) {
    const page = await historyMessagePage(fetchImpl, options.accessToken, options.startHistoryId, undefined, options.coverage === 'uu06')
    if (page.expired) {
      recoveryGapReason = `Gmail history cursor ${options.startHistoryId} expired before PJSDAS could prove complete consumption; bounded recent recovery cannot prove older mailbox coverage.`
      await fallbackPage(undefined, currentHistoryId)
    } else {
      mode = 'history'
      ids = page.ids
      nextPageToken = page.nextPageToken
      pendingHistoryId = currentHistoryId
    }
  } else {
    await fallbackPage(undefined, currentHistoryId)
  }

  const bounded = boundedPage(ids!, {
    mode: mode!,
    pageToken: nextPageToken,
    pendingHistoryId: pendingHistoryId!,
  }, options.coverage === 'uu06' ? UU06_MAX_MESSAGES_PER_RUN : LEGACY_MAX_MESSAGES_PER_RUN)
  return {
    messages: await fetchMessages(fetchImpl, options.accessToken, bounded.selected),
    nextHistoryId: bounded.nextHistoryId,
    continuation: bounded.continuation,
    coverageComplete: bounded.coverageComplete,
    usedFallbackScan,
    recoveryGapReason,
  }
}

function stableCoverageGapId(startHistoryId: string, checkedAt: string) {
  const value = `${startHistoryId}|${checkedAt.slice(0, 10)}`
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function requiresTiming(type: ProcessEventType | undefined) {
  return Boolean(type && ['assessment_invite', 'written_test_invite', 'interview_invite'].includes(type))
}

export function gmailObservationFromMessage(
  message: GmailMessage,
  opportunities: Opportunity[],
  now = new Date(),
): HardenedGmailMessageObservation | undefined {
  if (!message.id) return undefined
  const subject = header(message.payload, 'subject')
  const sender = header(message.payload, 'from')
  const body = messageBodyText(message.payload)
  const text = [subject, message.snippet, body].map(cleanText).filter(Boolean).join('\n').slice(0, 16_000)
  const parsed = parseRecruitingNotification(text, opportunities, now)
  const eventType = parsed.type && parsed.confidence.type !== 'low' ? parsed.type : undefined
  const recruiting = Boolean(parsed.candidates.length > 0 || (eventType && eventType !== 'other'))
  const receivedAt = message.internalDate && Number.isFinite(Number(message.internalDate))
    ? new Date(Number(message.internalDate)).toISOString()
    : now.toISOString()

  if (!recruiting) {
    return {
      sourceRecordId: message.id,
      receivedAt,
      classification: 'ignored',
      confidence: 'high',
      sender: sender || undefined,
      subject: subject || undefined,
    }
  }

  const selected = parsed.opportunity
  const timingSatisfied = !requiresTiming(eventType) || Boolean(parsed.dueAt)
  const confidence = selected && parsed.confidence.opportunity === 'high' && parsed.confidence.type === 'high' && timingSatisfied
    ? 'high'
    : selected && parsed.confidence.opportunity !== 'low' && parsed.confidence.type !== 'low'
      ? 'medium'
      : 'low'
  const notes = parsed.warnings.length
    ? `Gmail 自动解析：${parsed.warnings.join('；')}`.slice(0, 800)
    : undefined
  const eventKey = message.threadId && eventType
    ? `${message.threadId}:${eventType}:${selected?.id ?? 'unresolved'}`
    : undefined

  return {
    sourceRecordId: message.id,
    receivedAt,
    classification: 'recruiting',
    confidence,
    sender: sender || undefined,
    subject: subject || undefined,
    company: selected?.company,
    role: selected?.role,
    eventType,
    eventKey,
    dueAt: parsed.dueAt,
    timingMode: parsed.timingMode,
    estimatedMinutes: parsed.estimatedMinutes,
    notes,
    stage: eventType ? stageForProcessEvent(eventType) : undefined,
  }
}

/** Bounded structured adapter. Raw mail/attachment/link content never enters receipts. */
export function gmailSemanticRecordFromMessage(
  message: GmailMessage,
  opportunities: Opportunity[],
  now = new Date(),
): GmailSemanticRecord | undefined {
  const originalHeaderTime = Date.parse(header(message.payload, 'date'))
  const originalInternalTime = message.internalDate ? Number(message.internalDate) : NaN
  const originalTime = Number.isFinite(originalInternalTime) && !Number.isNaN(new Date(originalInternalTime).getTime())
    ? originalInternalTime : originalHeaderTime
  const originalReceivedAt = Number.isFinite(originalTime) ? new Date(originalTime).toISOString() : undefined
  const prior = gmailObservationFromMessage(message, opportunities, now)
  if (!prior) return undefined
  const legacy = { ...prior, receivedAt: originalReceivedAt ?? prior.receivedAt }
  const excluded = message.labelIds?.some((label) => label === 'SPAM' || label === 'TRASH')
  const body = excluded ? '' : messageBodyText(message.payload)
  const subject = excluded ? '' : header(message.payload, 'subject')
  const text = excluded ? '' : body || subject || cleanText(message.snippet)
  const gaps: string[] = originalReceivedAt ? [] : ['Original message timestamp is unavailable; automatic facts require clarification.']
  const visit = (part: GmailPart | undefined) => {
    if (!part) return
    if (part.filename) gaps.push('Attachment content is NOT_SUPPORTED; inspect the original mail if it contains material details.')
    for (const child of part.parts ?? []) visit(child)
  }
  if (!excluded) visit(message.payload)
  if (/https?:\/\//i.test(text)) gaps.push('Linked pages are NOT_SUPPORTED; no link is opened or treated as verified source content.')
  if (body.length >= 12_000) gaps.push('Message exceeds the bounded body limit; remaining content was not interpreted.')
  const quoted = /(?:^|\n)\s*>|(?:转发邮件|原始邮件|Original Message|On .+ wrote:|示例|假设|假如|hypothetical|for example)/i.test(text)
  if (quoted) gaps.push('Quoted/forwarded context requires clarification; no automatic facts were written.')
  const pieces = text.split(/[；;。\n]+/).map((item) => item.trim()).filter(Boolean)
  if (pieces.length > 20) gaps.push('Message exceeds the 20-fragment interpretation limit.')
  const whole = parseRecruitingNotification([subject, text].join('\n'), opportunities, new Date(legacy.receivedAt))
  const subjectType = /interview invitation/i.test(subject) ? 'interview_invite'
    : /(?:assessment|test) invitation/i.test(subject) ? 'assessment_invite'
    : whole.type && whole.type !== 'other' && whole.confidence.type === 'high' ? whole.type : undefined
  const bodyHasEvent = pieces.some((piece) => {
    const parsed = parseRecruitingNotification(piece, opportunities, new Date(legacy.receivedAt))
    return parsed.type && parsed.type !== 'other' && parsed.confidence.type !== 'low'
  })
  if (!bodyHasEvent && subjectType) pieces.splice(0, pieces.length, text)
  const timedContextTypes = [...new Set(pieces.map((piece) => parseRecruitingNotification(piece, opportunities, new Date(legacy.receivedAt)).type)
    .filter((type) => type && requiresTiming(type)))]
  const deadlineContextType = timedContextTypes.length === 1 ? timedContextTypes[0] : undefined
  const candidates: SemanticCandidate[] = []
  for (const [index, piece] of pieces.slice(0, 20).entries()) {
    const parsed = parseRecruitingNotification(piece, opportunities, new Date(legacy.receivedAt))
    const selected = parsed.opportunity ?? whole.opportunity
    const submissionDeadline = /(?:提交|交卷|submission|submit).{0,12}(?:截止|最晚|deadline|by)|(?:截止|deadline).{0,12}(?:提交|交卷|submission|submit)/i.test(piece)
    const eventType = submissionDeadline && deadlineContextType ? deadlineContextType
      : parsed.type && parsed.type !== 'other' ? parsed.type : !bodyHasEvent ? subjectType : undefined
    const eventConfidence = !originalReceivedAt ? 'low' as const : eventType === parsed.type ? parsed.confidence.type : 'high' as const
    const application = /(?:投递|申请).{0,12}(?:成功|已收到)|(?:application).{0,20}(?:received|submitted|confirmed)/i.test(piece)
    if (!application && (!eventType || parsed.confidence.type === 'low' && eventType === parsed.type)) continue
    const evidenceRef = `gmail:primary:${message.id}:fragment:${index}`
    const base = {
      id: `fragment:${index}`,
      target: selected ? { opportunityId: selected.id } : undefined,
      objectConfidence: selected ? (parsed.opportunity ? parsed.confidence.opportunity : whole.confidence.opportunity) : 'low' as const,
      eventConfidence: !originalReceivedAt ? 'low' as const : application ? 'high' as const : eventConfidence,
      evidenceRefs: [evidenceRef], sourceVersionRefs: [`${message.id}:uu06-v1`],
    }
    if (application) {
      candidates.push({ ...base, kind: 'application_submitted', occurredAt: legacy.receivedAt })
      continue
    }
    const occurrenceKind = eventType === 'interview_invite' ? 'interview' as const
      : eventType === 'written_test_invite' ? 'written_test' as const : eventType === 'assessment_invite' ? 'assessment' as const : undefined
    if (occurrenceKind && /取消|撤销|cancelled|canceled/i.test(piece)) {
      candidates.push({ ...base, kind: 'occurrence_cancelled', target: { ...base.target, occurrenceKind }, occurredAt: legacy.receivedAt })
      continue
    }
    if (occurrenceKind && /(?:已完成|已经完成|完成回执|已提交|completed)/i.test(piece)) {
      candidates.push({ ...base, kind: 'occurrence_completed', target: { ...base.target, occurrenceKind }, occurredAt: legacy.receivedAt })
      continue
    }
    const originalTimestamp = originalReceivedAt ?? ''
    const temporal = resolveSourceTemporal(piece, { receivedAt: originalTimestamp,
      timezone: 'Asia/Shanghai', mode: submissionDeadline ? 'deadline' : parsed.timingMode })
    const dueAt = temporal?.startAt ?? temporal?.deadlineAt ?? temporal?.date
    const duePrecision = temporal?.precision
    if (occurrenceKind && /改期|改为|调整为|reschedul/i.test(piece)) {
      if (temporal) {
        candidates.push({ ...base, kind: 'occurrence_rescheduled', temporal, temporalConfidence: 'high', target: { ...base.target, occurrenceKind } })
      } else gaps.push('Reschedule lacks an unambiguous full date/time; the existing occurrence was preserved.')
      continue
    }
    const location = /(?:地点|location|venue)\s*[:：]\s*([^；;。\n]+)/i.exec(piece)?.[1]?.trim().slice(0, 200)
    const rawLink = /https:\/\/[^\s<>()；;。]+/.exec(piece)?.[0]
    let joinUrl: string | undefined
    if (rawLink && rawLink.length <= 500) {
      try { const url = new URL(rawLink); if (!url.username && !url.password) joinUrl = url.href } catch { /* incomplete links remain unsupported */ }
    }
    candidates.push({
      ...base, kind: 'process_event', eventType: eventType!, occurredAt: legacy.receivedAt,
      target: { ...base.target, ...(message.threadId && dueAt ? {
        occurrenceId: `gmail:primary:thread:${message.threadId}:${selected?.id ?? 'unresolved'}:${eventType}:${temporal?.shape ?? 'unknown'}:${dueAt}`,
      } : {}) },
      temporal, dueAt, duePrecision, timingMode: submissionDeadline ? 'deadline' : parsed.timingMode, estimatedMinutes: parsed.estimatedMinutes, location, joinUrl,
      temporalConfidence: occurrenceKind ? (dueAt ? 'high' : 'low') : undefined,
    })
  }
  const eventCandidates = candidates.filter((candidate) => candidate.kind === 'process_event')
  if (eventCandidates.length === 1) {
    const candidate = eventCandidates[0]!
    candidate.location ??= /(?:地点|location|venue)\s*[:：]\s*([^；;。\n]+)/i.exec(text)?.[1]?.trim().slice(0, 200)
    const rawLink = /https:\/\/[^\s<>()；;。]+/.exec(text)?.[0]
    if (!candidate.joinUrl && rawLink && rawLink.length <= 500) {
      try { const url = new URL(rawLink); if (!url.username && !url.password) candidate.joinUrl = url.href } catch { /* keep unsupported link gap */ }
    }
  } else if (eventCandidates.length > 1 && /(?:地点|location|venue)\s*[:：]|https:\/\//i.test(text)
    && eventCandidates.some((candidate) => !candidate.location && !candidate.joinUrl)) {
    gaps.push('Supplementary location/link details could not be uniquely assigned across multiple events.')
  }
  return {
    receivedAt: legacy.receivedAt,
    gaps: !excluded && (legacy.classification === 'recruiting' || candidates.length) ? [...new Set(gaps)] : [],
    observation: {
      contractVersion: 1, inputId: `gmail:${message.id}:uu06-v1`,
      source: { kind: 'gmail', sourceId: GMAIL_SOURCE_ID, sourceRecordId: message.id!,
        sourceVersion: 'uu06-v1', observedAt: now.toISOString(), assertedAt: legacy.receivedAt, timezone: 'Asia/Shanghai' },
      originalTextFingerprint: `fnv1a:${stableIngestionHash(text)}`,
      statementMode: quoted ? 'quote' : 'assertion', candidates,
    },
  }
}

export async function runGmailAutomationForBinding(options: {
  binding: GmailAutomationBinding
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  fetchImpl?: typeof fetch
  now?: () => Date
  execution?: { beforeWorkspaceWrite: () => Promise<void> }
}): Promise<GmailAutomationRunResult> {
  if (options.binding.gmailIntakeConsentVersion !== 'uu06-v1') return runLegacyGmailAutomationForBinding(options)
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now?.() ?? new Date()
  const checkedAt = now.toISOString()
  if (!options.binding.grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
    throw new WorkspaceSourceError('GOOGLE_GMAIL_SCOPE_MISSING', 'Gmail automation requires the Gmail read-only permission. Reconnect Google and enable recruiting-email tracking.', false)
  }

  const refreshToken = await decryptSecret(options.binding.refreshTokenCiphertext, options.tokenEncryptionKey)
  const accessToken = await refreshGoogleAccessToken(refreshToken, {
    clientId: options.googleClientId,
    clientSecret: options.googleClientSecret,
    fetchImpl,
  })
  const batch = await fetchGmailAutomationBatch({
    accessToken,
    startHistoryId: options.binding.gmailHistoryId,
    continuation: options.binding.gmailSyncMode && options.binding.gmailPendingHistoryId ? {
      mode: options.binding.gmailSyncMode,
      pageToken: options.binding.gmailPageToken,
      pendingHistoryId: options.binding.gmailPendingHistoryId,
      pendingMessageIds: options.binding.gmailPendingMessageIds,
    } : undefined,
    fetchImpl, now, coverage: 'uu06',
  })

  if (canFinalizeEmptyGmailHistoryWithoutWorkspace(options.binding.gmailHistoryId, batch)) {
    return {
      userId: options.binding.userId,
      checkedAt,
      nextHistoryId: batch.nextHistoryId,
      continuation: batch.continuation,
      coverageComplete: batch.coverageComplete,
      recoveryGapDetected: false,
      receivedCount: 0,
      accountedCount: 0,
      unresolvedCount: 0,
      alreadyApplied: true,
      usedFallbackScan: false,
      ...(options.execution ? {
        metrics: {
          status: 'completed',
          mode: 'history',
          receivedCount: 0,
          accountedCount: 0,
          unresolvedCount: 0,
          historyLag: aggregateHistoryLag([], (options.now?.() ?? new Date()).getTime()),
        } satisfies GmailExecutionMetrics,
      } : {}),
    }
  }

  const transactionalAuthority = process.env.PJSDAS_CONNECTED_AUTHORITY?.trim() === 'transactional'
  const source = transactionalAuthority
    ? createTransactionalWorkspaceSource({
        userId: options.binding.userId,
        supabaseUrl: PJSDAS_SUPABASE_URL,
        serviceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
        principalKind: 'automation',
        sourceId: GMAIL_SOURCE_ID,
        timezone: 'Asia/Shanghai',
        fetchImpl,
      })
    : createDriveWorkspaceSource({
        getAccessToken: () => accessToken,
        fetchImpl,
        timezone: 'Asia/Shanghai',
      })
  const workspace = await source.read()
  const backfillComplete = (workspace.snapshot.data.timeline ?? []).some((item) =>
    item.ingestion?.sourceKind === 'gmail' && item.ingestion.sourceId === GMAIL_SOURCE_ID
    && item.ingestion.sourceRecordId === 'coverage-boundary:uu06-90-days')
  const records = batch.messages
    .map((message) => gmailSemanticRecordFromMessage(message, workspace.snapshot.data.opportunities, now))
    .filter((record): record is GmailSemanticRecord => Boolean(record))
  if (!backfillComplete && batch.usedFallbackScan && batch.coverageComplete) {
    records.unshift({
      receivedAt: checkedAt,
      gaps: ['Gmail initial backfill covers the previous 90 days, including archived mail; older mail and spam/trash are outside this bounded coverage. Push delivery is not configured; periodic history polling remains active.'],
      observation: { contractVersion: 1, inputId: 'gmail:coverage-boundary:uu06-90-days',
        source: { kind: 'gmail', sourceId: GMAIL_SOURCE_ID, sourceRecordId: 'coverage-boundary:uu06-90-days', observedAt: checkedAt, timezone: 'Asia/Shanghai' },
        statementMode: 'assertion', candidates: [] },
    })
  }
  if (batch.recoveryGapReason) {
    records.unshift({
      receivedAt: checkedAt, gaps: [batch.recoveryGapReason],
      observation: {
        contractVersion: 1, inputId: `gmail:coverage-gap:${stableCoverageGapId(options.binding.gmailHistoryId ?? 'initial', checkedAt)}`,
        source: { kind: 'gmail', sourceId: GMAIL_SOURCE_ID,
          sourceRecordId: `coverage-gap:${stableCoverageGapId(options.binding.gmailHistoryId ?? 'initial', checkedAt)}`,
          observedAt: checkedAt, timezone: workspace.context.timezone ?? 'Asia/Shanghai' },
        statementMode: 'assertion', candidates: [],
      },
    })
  }
  const result = applyGmailSemanticBatch(workspace.snapshot, {
    runId: `gmail:auto:${checkedAt}`, sourceId: GMAIL_SOURCE_ID, checkedAt,
    cursor: batch.coverageComplete ? batch.nextHistoryId : undefined, records,
    authorized: true, workspaceRevision: workspace.context.workspaceVersion,
  })

  let workspaceVersion = workspace.context.workspaceVersion
  if (!result.alreadyApplied) {
    await options.execution?.beforeWorkspaceWrite()
    const writable = requireWritableWorkspaceSource(source)
    const written = await writable.write({
      snapshot: result.snapshot,
      expectedWorkspaceVersion: workspace.context.workspaceVersion,
      updatedByDevice: 'gmail-automation-worker',
      command: {
        commandId: `gmail:auto:${checkedAt}`, operation: 'gmail_semantic_intake',
        payload: { sourceId: GMAIL_SOURCE_ID, recordIds: records.map((record) => record.observation.source.sourceRecordId) },
        provenance: { sourceId: GMAIL_SOURCE_ID, adapterVersion: 'uu06-v1' },
        compensation: { ...result.compensation }, effectiveTime: checkedAt,
      },
    })
    workspaceVersion = written.context.workspaceVersion
  }

  return {
    userId: options.binding.userId,
    checkedAt,
    nextHistoryId: batch.nextHistoryId,
    continuation: batch.continuation,
    coverageComplete: batch.coverageComplete,
    recoveryGapDetected: Boolean(batch.recoveryGapReason),
    receivedCount: result.run.receivedCount,
    accountedCount: result.run.accountedCount,
    unresolvedCount: result.run.outcomes.unresolved ?? 0,
    alreadyApplied: result.alreadyApplied,
    workspaceVersion,
    usedFallbackScan: batch.usedFallbackScan,
    ...(options.execution ? { metrics: executionMetrics(options.binding, batch, workspace.snapshot.data.timeline ?? [],
      (options.now?.() ?? new Date()).getTime(), result.run.accountedCount, result.run.outcomes.unresolved ?? 0) } : {}),
  }
}

async function runLegacyGmailAutomationForBinding(options: {
  binding: GmailAutomationBinding
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  fetchImpl?: typeof fetch
  now?: () => Date
  execution?: { beforeWorkspaceWrite: () => Promise<void> }
}): Promise<GmailAutomationRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now?.() ?? new Date()
  const checkedAt = now.toISOString()
  if (!options.binding.grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
    throw new WorkspaceSourceError('GOOGLE_GMAIL_SCOPE_MISSING', 'Gmail automation requires the Gmail read-only permission. Reconnect Google and enable recruiting-email tracking.', false)
  }

  const refreshToken = await decryptSecret(options.binding.refreshTokenCiphertext, options.tokenEncryptionKey)
  const accessToken = await refreshGoogleAccessToken(refreshToken, {
    clientId: options.googleClientId,
    clientSecret: options.googleClientSecret,
    fetchImpl,
  })
  const transactionalAuthority = process.env.PJSDAS_CONNECTED_AUTHORITY?.trim() === 'transactional'
  const source = transactionalAuthority
    ? createTransactionalWorkspaceSource({
        userId: options.binding.userId,
        supabaseUrl: PJSDAS_SUPABASE_URL,
        serviceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
        principalKind: 'automation',
        sourceId: GMAIL_SOURCE_ID,
        timezone: 'Asia/Shanghai',
        fetchImpl,
      })
    : createDriveWorkspaceSource({
        getAccessToken: () => accessToken,
        fetchImpl,
        timezone: 'Asia/Shanghai',
      })
  const workspace = await source.read()
  const batch = await fetchGmailAutomationBatch({
    accessToken,
    startHistoryId: options.binding.gmailHistoryId,
    continuation: options.binding.gmailSyncMode && options.binding.gmailPendingHistoryId ? {
      mode: options.binding.gmailSyncMode,
      pageToken: options.binding.gmailPageToken,
      pendingHistoryId: options.binding.gmailPendingHistoryId,
      pendingMessageIds: options.binding.gmailPendingMessageIds,
    } : undefined,
    fetchImpl,
  })
  const messages = batch.messages
    .map((message) => gmailObservationFromMessage(message, workspace.snapshot.data.opportunities, now))
    .filter((message): message is HardenedGmailMessageObservation => Boolean(message))
  if (batch.recoveryGapReason) {
    messages.unshift({
      sourceRecordId: `coverage-gap:${stableCoverageGapId(options.binding.gmailHistoryId ?? 'initial', checkedAt)}`,
      receivedAt: checkedAt,
      classification: 'recruiting',
      confidence: 'low',
      subject: 'PJSDAS Gmail coverage gap',
      notes: batch.recoveryGapReason.slice(0, 800),
    })
  }
  const result = applyGmailIngestionHardened(workspace.snapshot, {
    runId: `gmail:auto:${checkedAt}`,
    sourceId: GMAIL_SOURCE_ID,
    startedAt: checkedAt,
    completedAt: checkedAt,
    cursor: batch.coverageComplete ? batch.nextHistoryId : undefined,
    sourcePolicy: bootstrapPolicyFor('gmail', GMAIL_SOURCE_ID),
    messages,
  })

  let workspaceVersion = workspace.context.workspaceVersion
  if (!result.alreadyApplied) {
    await options.execution?.beforeWorkspaceWrite()
    const writable = requireWritableWorkspaceSource(source)
    const written = await writable.write({
      snapshot: result.snapshot,
      expectedWorkspaceVersion: workspace.context.workspaceVersion,
      updatedByDevice: 'gmail-automation-worker',
    })
    workspaceVersion = written.context.workspaceVersion
  }

  return {
    userId: options.binding.userId,
    checkedAt,
    nextHistoryId: batch.nextHistoryId,
    continuation: batch.continuation,
    coverageComplete: batch.coverageComplete,
    recoveryGapDetected: Boolean(batch.recoveryGapReason),
    receivedCount: result.run.receivedCount,
    accountedCount: result.run.accountedCount,
    unresolvedCount: result.run.outcomes.unresolved ?? 0,
    alreadyApplied: result.alreadyApplied,
    workspaceVersion,
    usedFallbackScan: batch.usedFallbackScan,
    ...(options.execution ? { metrics: executionMetrics(options.binding, batch, workspace.snapshot.data.timeline ?? [],
      (options.now?.() ?? new Date()).getTime(), result.run.accountedCount, result.run.outcomes.unresolved ?? 0) } : {}),
  }
}

export function canFinalizeEmptyGmailHistoryWithoutWorkspace(
  startHistoryId: string | undefined,
  batch: GmailAutomationFetchResult,
) {
  return Boolean(startHistoryId && !batch.usedFallbackScan && !batch.recoveryGapReason && batch.messages.length === 0)
}

function executionMetrics(binding: GmailAutomationBinding, batch: GmailAutomationFetchResult,
  timeline: import('../src/model.js').TimelineRecord[], committedAt: number, accounted: number, unresolved: number): GmailExecutionMetrics {
  const mode = batch.usedFallbackScan ? binding.gmailHistoryId ? 'history_recovery' : 'initial_backfill' : 'history'
  const receivedTimes = mode === 'history' ? batch.messages.filter((message) => message.id
    && !alreadyIngested(timeline, { sourceKind: 'gmail', sourceId: GMAIL_SOURCE_ID, sourceRecordId: message.id }))
    .map((message) => message.internalDate ? Number(message.internalDate) : Date.parse(header(message.payload, 'date'))) : []
  return { status: 'completed', mode, receivedCount: batch.messages.length,
    accountedCount: Math.min(accounted, batch.messages.length), unresolvedCount: Math.min(unresolved, batch.messages.length),
    ...(mode === 'history' ? { historyLag: aggregateHistoryLag(receivedTimes, committedAt) } : {}) }
}
