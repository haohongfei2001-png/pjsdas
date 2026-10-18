import { parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5'
import type { GmailExecutionObserver } from './gmailExecutionDiagnostics.js'
import type { GoogleRefreshLifecycle } from './googleRefreshLifecycle.js'
import { dismissedSemanticCandidate } from '../src/decisionDismissal.js'
import { aggregateHistoryLag, type GmailExecutionMetrics } from './gmailExecutionMetrics.js'
import {
  GMAIL_RECONCILIATION_STATES,
  emptyGmailReconciliationAccumulator,
  mergeGmailReconciliationAccumulator,
  type GmailReconciliationAccumulator,
  type GmailReconciliationContinuationState,
} from './gmailReconciliationState.js'
import { canonicalOpportunityId } from '../src/opportunityCanonicalization.js'
import { semanticCandidateFactKey } from '../src/semanticIntake.js'
import { resolveSourceTemporal } from '../src/sourceTemporal.js'
import { commonNotificationCompany, notificationIdentityCanInherit, notificationIdentityCompatible, notificationIdentityText, parseRecruitingNotification } from '../src/notificationParser.js'
import { stageForProcessEvent } from '../src/processEvents.js'
import {
  applyGmailIngestionHardened,
  type HardenedGmailMessageObservation,
} from '../src/ingestionHardening.js'
import { bootstrapPolicyFor } from '../src/sourceRegistry.js'
import { alreadyIngested, stableIngestionHash } from '../src/ingestion.js'
import { validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { applyGmailSemanticBatch, GMAIL_RESCHEDULE_TIME_GAP, type GmailSemanticRecord } from '../src/gmailSemanticIntake.js'
import type {
  GmailReconciliationProof,
  GmailReconciliationState,
  Opportunity,
  ProcessEventType,
  SemanticCandidate,
} from '../src/model.js'
import { createDriveWorkspaceSource } from './driveWorkspaceSource.js'
import { createTransactionalWorkspaceSource } from './transactionalWorkspaceSource.js'
import { refreshGoogleAccessToken } from './googleOAuthTokens.js'
import { decryptSecret } from './tokenCrypto.js'
import { GMAIL_READONLY_SCOPE, type GmailAutomationBinding } from './automationConnectionStore.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError } from './workspaceSource.js'
import { gmailProviderRequestError, type GmailProviderOperation } from './gmailProviderFailure.js'
import { PJSDAS_SUPABASE_URL } from './supabaseProject.js'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GMAIL_SOURCE_ID = 'gmail:primary'
const GMAIL_PROVIDER_PAGE_SIZE = 100
const LEGACY_MAX_MESSAGES_PER_RUN = 100
export const UU06_MAX_MESSAGES_PER_RUN = 20
export const INITIAL_LOOKBACK_DAYS = 90
export const RECONCILIATION_LOOKBACK_DAYS = 7
export const RECONCILIATION_MAX_MESSAGES = 5000
export const RECONCILIATION_BATCH_SIZE = UU06_MAX_MESSAGES_PER_RUN
// A whole-snapshot commit can consume most of the unchanged execution window.
// Keep one complete source message atomic; never advance an uncommitted cursor.
export const RECONCILIATION_PARSE_SLICE_SIZE = 1
const GMAIL_RECONCILIATION_PARSER_VERSION = 'reconciliation-v2'
export const GMAIL_FRAGMENT_PARSE_LIMIT = 80

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
  unavailableMessageIds: string[]
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

export type GmailReconciliationSummary = Omit<GmailReconciliationProof, 'version'> & {
  actionableCount: number
  unresolvedCount: number
}

export interface GmailReconciliationRunResult {
  userId: string
  checkedAt: string
  alreadyApplied: boolean
  workspaceVersion?: string
  cycleComplete: boolean
  continuation?: GmailReconciliationContinuationState
  summary: GmailReconciliationSummary
  metrics: GmailExecutionMetrics
}

function cleanText(value: string | undefined) {
  return (value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim()
}

function header(part: GmailPart | undefined, name: string) {
  return cleanText(part?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value)
}

/** Narrow proof for the new bound-notice path only. Never infer a sender
 * clock from this worker's host timezone or normalize malformed provider data. */
function boundGmailSourceInstant(message: GmailMessage, now: Date): string | undefined {
  if (message.internalDate !== undefined) {
    if (typeof message.internalDate !== 'string' || !/^\d{1,16}$/.test(message.internalDate)) return undefined
    const value = Number(message.internalDate)
    if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime()) || value > now.getTime()) return undefined
    return new Date(value).toISOString()
  }
  const dates = message.payload?.headers?.filter(item => item.name?.toLowerCase() === 'date') ?? []
  if (dates.length !== 1) return undefined
  const value = cleanText(dates[0]?.value)
  const match = /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat), )?(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))? ([+-])([01]\d|2[0-3])([0-5]\d)$/i.exec(value)
  if (!match) return undefined
  const year = Number(match[4]), day = Number(match[2])
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(match[3]!.toLowerCase())
  const calendar = new Date(Date.UTC(year, month, day, Number(match[5]), Number(match[6]), Number(match[7] ?? 0)))
  if (year < 1900 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month || calendar.getUTCDate() !== day
    || match[1] && ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][calendar.getUTCDay()] !== match[1].toLowerCase()) return undefined
  const offset = (Number(match[9]) * 60 + Number(match[10])) * (match[8] === '+' ? 1 : -1)
  const instant = calendar.getTime() - offset * 60_000
  return instant <= now.getTime() ? new Date(instant).toISOString() : undefined
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
    .replace(/<\/?(?:p|div|li|tr|h[1-6]|section|article|blockquote)(?:\s[^>]*)?>/gi, '\n')
    .replace(/<\/?(?:span|font|b|strong|i|em|u|a|small|sup|sub)(?:\s[^>]*)?>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
}

/** Unsupported HTML is coverage debt, never a successfully parsed prefix. */
function semanticHtmlText(value: string): string | undefined {
  // Limit the input before parse5 allocates a tree. Depth and node bounds are
  // checked iteratively before serialize (which also traverses recursively).
  if (value.length > 128 * 1024) return undefined
  try {
    const document = parseFragment(value)
    const stack: Array<{ node: DefaultTreeAdapterTypes.Node; depth: number }> = [{ node: document, depth: 0 }]
    let count = 0
    while (stack.length) {
      const { node, depth } = stack.pop()!
      if (++count > 4096 || depth > 64) return undefined
      if ('tagName' in node) {
        // Template content is inert and has a separate tree; it is not an
        // understood current-body assertion or part of this bounded reader.
        if (node.tagName === 'template') return undefined
        const attribute = (name: string) => node.attrs.find(item => item.name === name)?.value.toLowerCase() ?? ''
        const classes = attribute('class').split(/\s+/)
        if (node.tagName === 'blockquote' || attribute('type') === 'cite'
          || classes.some(name => ['gmail_quote', 'gmail_quote_container', 'yahoo_quoted', 'moz-cite-prefix'].includes(name))
          || attribute('id') === 'divrplyfwdmsg') {
          node.childNodes = [{ nodeName: '#text', value: '\n> quoted mail thread\n', parentNode: node }]
          continue
        }
      }
      if ('childNodes' in node) {
        for (const child of node.childNodes) stack.push({ node: child, depth: depth + 1 })
      }
    }
    return stripHtml(serialize(document))
  } catch {
    return undefined
  }
}

function messageBodyContent(part: GmailPart | undefined, preserveQuoteBoundary = false) {
  const plain: string[] = [], html: string[] = []
  const visit = (item: GmailPart) => {
    if (item.filename) return
    const decoded = decodeBase64Url(item.body?.data)
    if (decoded) {
      if (item.mimeType?.toLowerCase().startsWith('text/plain')) plain.push(decoded)
      else if (item.mimeType?.toLowerCase().startsWith('text/html')) html.push(decoded)
    }
    for (const child of item.parts ?? []) visit(child)
  }
  if (part) visit(part)
  // A preferred plaintext alternative does not require interpreting its HTML
  // duplicate. Never let an unused complex HTML part poison valid plain mail.
  const bodies = plain.length ? plain : html.map(value => preserveQuoteBoundary ? semanticHtmlText(value) : stripHtml(value))
  return { text: bodies.filter(value => value !== undefined).join('\n').replace(/\u0000/g, '').trim().slice(0, 12_000),
    uninterpretedHtml: bodies.some(value => value === undefined) }
}

function messageBodyText(part: GmailPart | undefined) {
  return messageBodyContent(part).text
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

function gmailOperation(path: string): GmailProviderOperation {
  if (path === '/profile') return 'profile'
  if (path.startsWith('/history?')) return 'history'
  if (path.startsWith('/messages?')) return 'list'
  if (path.startsWith('/messages/')) return 'message_fetch'
  return 'unknown'
}

async function gmailFetch(fetchImpl: typeof fetch, accessToken: string, path: string) {
  let response: Response
  const operation = gmailOperation(path)
  try {
    response = await fetchImpl(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    })
  } catch {
    throw new WorkspaceSourceError('GMAIL_UNAVAILABLE', 'Gmail is temporarily unavailable.', true)
  }
  if (response.status === 401) {
    throw await gmailProviderRequestError(
      response, operation, 'GOOGLE_ACCESS_REJECTED',
      'Google rejected the current access token. A later check will retry authorization.', true,
    )
  }
  if (response.status === 403) {
    const forbidden = await gmailForbiddenError(response)
    throw await gmailProviderRequestError(
      response, operation, forbidden.code, forbidden.message, forbidden.retryable,
    )
  }
  if (response.status === 429 || response.status >= 500) {
    throw await gmailProviderRequestError(
      response, operation, 'GMAIL_UNAVAILABLE',
      `Gmail is temporarily unavailable (HTTP ${response.status}).`, true,
    )
  }
  return response
}

async function gmailJson<T>(fetchImpl: typeof fetch, accessToken: string, path: string): Promise<T> {
  const response = await gmailFetch(fetchImpl, accessToken, path)
  if (!response.ok) {
    throw await gmailProviderRequestError(
      response, gmailOperation(path), 'GMAIL_REQUEST_FAILED',
      `Gmail request failed (HTTP ${response.status}).`, false,
    )
  }
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
  if (!response.ok) {
    throw await gmailProviderRequestError(
      response, 'history', 'GMAIL_REQUEST_FAILED',
      `Gmail history request failed (HTTP ${response.status}).`, false,
    )
  }
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
  const unavailableMessageIds: string[] = []
  for (let index = 0; index < ids.length; index += 5) {
    const batch = ids.slice(index, index + 5)
    const settled = await Promise.all(batch.map(async (id) => {
      const response = await gmailFetch(fetchImpl, accessToken, `/messages/${encodeURIComponent(id)}?format=full`)
      if (response.status === 404 || response.status === 410) {
        return { kind: 'unavailable' as const, id }
      }
      if (!response.ok) {
        throw await gmailProviderRequestError(
          response, 'message_fetch', 'GMAIL_REQUEST_FAILED',
          `Gmail message fetch failed (HTTP ${response.status}).`, false,
        )
      }
      const message = await response.json().catch(() => undefined) as GmailMessage | undefined
      if (!message) throw new WorkspaceSourceError('GMAIL_RESPONSE_INVALID', 'Gmail returned malformed message JSON.', true)
      return { kind: 'message' as const, message }
    }))
    for (const item of settled) {
      if (item.kind === 'unavailable') unavailableMessageIds.push(item.id)
      else messages.push(item.message)
    }
  }
  return { messages, unavailableMessageIds }
}

export async function fetchGmailSemanticRecordsByIds(options: {
  accessToken: string
  messageIds: string[]
  opportunities: Opportunity[]
  fetchImpl?: typeof fetch
  now?: Date
}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? new Date()
  const uniqueIds = [...new Set(options.messageIds)]
  if (uniqueIds.length > 100) {
    throw new WorkspaceSourceError(
      'GMAIL_FRAGMENT_REPROCESS_LIMIT_EXCEEDED',
      'Gmail fragment-limit reprocessing accepts at most 100 source records in one bounded dry-run.',
      false,
    )
  }
  const fetched = await fetchMessages(fetchImpl, options.accessToken, uniqueIds)
  const records = fetched.messages
    .map((message) => gmailSemanticRecordFromMessage(message, options.opportunities, now))
    .filter((record): record is GmailSemanticRecord => Boolean(record))
  return {
    requestedCount: uniqueIds.length,
    fetchedCount: fetched.messages.length,
    unavailableCount: fetched.unavailableMessageIds.length,
    records,
  }
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
    const fetched = await fetchMessages(fetchImpl, options.accessToken, bounded.selected)
    return {
      messages: fetched.messages,
      unavailableMessageIds: fetched.unavailableMessageIds,
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
  const fetched = await fetchMessages(fetchImpl, options.accessToken, bounded.selected)
  return {
    messages: fetched.messages,
    unavailableMessageIds: fetched.unavailableMessageIds,
    nextHistoryId: bounded.nextHistoryId,
    continuation: bounded.continuation,
    coverageComplete: bounded.coverageComplete,
    usedFallbackScan,
    recoveryGapReason,
  }
}


async function reconciliationMessagePage(
  fetchImpl: typeof fetch,
  accessToken: string,
  cycleStartedAt: string,
  pageToken?: string,
) {
  const cycleMs = Date.parse(cycleStartedAt)
  if (!Number.isFinite(cycleMs)) {
    throw new WorkspaceSourceError('GMAIL_RECONCILIATION_STATE_INVALID', 'Gmail reconciliation continuation time is invalid.', false)
  }
  const after = Math.floor(cycleMs / 1000) - RECONCILIATION_LOOKBACK_DAYS * 86400
  const query = `{after:${after} is:unread} -in:spam -in:trash`
  const params = new URLSearchParams({ maxResults: String(GMAIL_PROVIDER_PAGE_SIZE), q: query })
  if (pageToken) params.set('pageToken', pageToken)
  const payload = await gmailJson<GmailMessageList>(fetchImpl, accessToken, `/messages?${params.toString()}`)
  return {
    ids: [...new Set((payload.messages ?? []).flatMap((item) => item.id ? [item.id] : []))],
    nextPageToken: payload.nextPageToken,
    query,
  }
}

export async function fetchGmailReconciliationBatch(options: {
  accessToken: string
  continuation?: GmailReconciliationContinuationState
  fetchImpl?: typeof fetch
  now?: Date
  maxMessages?: number
}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? new Date()
  const cycleStartedAt = options.continuation?.cycleStartedAt ?? now.toISOString()
  const priorAggregate = options.continuation?.aggregate ?? emptyGmailReconciliationAccumulator()
  let ids = [...(options.continuation?.pendingMessageIds ?? [])]
  let nextPageToken = options.continuation?.pageToken

  if (!ids.length) {
    const page = await reconciliationMessagePage(
      fetchImpl,
      options.accessToken,
      cycleStartedAt,
      options.continuation?.pageToken,
    )
    ids = page.ids
    nextPageToken = page.nextPageToken
  }

  if (priorAggregate.scannedCount + ids.length > RECONCILIATION_MAX_MESSAGES) {
    throw new WorkspaceSourceError(
      'GMAIL_RECONCILIATION_LIMIT_EXCEEDED',
      `Gmail reconciliation exceeded the bounded ${RECONCILIATION_MAX_MESSAGES}-record cycle limit.`,
      false,
    )
  }

  const limit = Math.max(1, Math.min(RECONCILIATION_BATCH_SIZE, Math.floor(options.maxMessages ?? RECONCILIATION_BATCH_SIZE)))
  const selectedMessageIds = ids.slice(0, limit)
  const pendingMessageIds = ids.slice(limit)
  const fetched = await fetchMessages(fetchImpl, options.accessToken, selectedMessageIds)
  const coverageComplete = pendingMessageIds.length === 0 && !nextPageToken

  return {
    ...fetched,
    scannedCount: selectedMessageIds.length,
    selectedMessageIds,
    cycleStartedAt,
    nextPageToken,
    pendingMessageIds,
    coverageComplete,
  }
}

function recentLiveProcesses(snapshot: import('../src/snapshot.js').PJSDASSnapshot, now: Date) {
  const cutoff = now.getTime() - 30 * 86_400_000
  const latestEventByOpportunity = new Map<string, number>()
  for (const event of snapshot.data.processEvents) {
    const value = new Date(event.occurredAt).getTime()
    if (!Number.isFinite(value)) continue
    latestEventByOpportunity.set(event.opportunityId, Math.max(latestEventByOpportunity.get(event.opportunityId) ?? 0, value))
  }
  return snapshot.data.processes.filter((process) => {
    if (process.stage === 'closed' || process.participationState === 'abandoned'
      || process.result === 'rejected' || process.result === 'closed_other') return false
    const last = process.lastProgressAt ? new Date(process.lastProgressAt).getTime()
      : process.opportunityId ? latestEventByOpportunity.get(process.opportunityId) : undefined
    return last === undefined || !Number.isFinite(last) || last >= cutoff
  })
}

/** Read-only reconciliation attribution, never a candidate or write authority.
 * A replay cannot bind the old-time precondition against the final snapshot;
 * instead require exact consumed source identity plus its committed mutation. */
function committedInterviewReschedule(record: GmailSemanticRecord, snapshot?: PJSDASSnapshot) {
  const pending = record.pendingInterviewReschedule, observation = record.observation, source = observation.source
  if (!snapshot || !pending || source.kind !== 'gmail' || observation.statementMode !== 'assertion'
    || observation.candidates.length || !observation.originalTextFingerprint
    || record.gaps.some(gap => gap !== GMAIL_RESCHEDULE_TIME_GAP)
    || record.issueKinds?.some(kind => kind !== 'business_ambiguity')) return undefined
  const prior = alreadyIngested(snapshot.data.timeline, { sourceKind: 'gmail', sourceId: source.sourceId, sourceRecordId: source.sourceRecordId })?.ingestion
  if (!prior || !['updated', 'duplicate'].includes(prior.outcome)
    || prior.fingerprint !== observation.originalTextFingerprint) return undefined
  const opportunityId = canonicalOpportunityId(snapshot, pending.opportunityId)
  for (const receipt of snapshot.data.semanticReceipts ?? []) {
    if (receipt.status !== 'committed' || receipt.sourceKind !== source.kind || receipt.sourceId !== source.sourceId
      || receipt.sourceRecordId !== source.sourceRecordId || !receipt.sourceVersion) continue
    for (const key of receipt.mutatedFactKeys ?? []) {
      if (!key.startsWith('occurrence_rescheduled|') || receipt.factInvalidations?.some(item => item.factKey === key)) continue
      const affected = receipt.factMutationObjects?.[key] ?? []
      if (!affected.some(item => item.type === 'opportunity' && canonicalOpportunityId(snapshot, item.id) === opportunityId)) continue
      const node = snapshot.data.scheduleNodes?.find(node => node.kind === 'interview'
        && node.opportunityId && canonicalOpportunityId(snapshot, node.opportunityId) === opportunityId
        && affected.some(item => item.type === 'schedule_node' && item.id === node.id)
        && node.evidenceRefs.includes(`${source.sourceId}:${source.sourceRecordId}:fragment:0`)
        && node.sourceVersionRefs.includes(`${source.sourceRecordId}:${receipt.sourceVersion}`)
        && semanticCandidateFactKey(snapshot, { id: 'reconciliation-proof-readonly', kind: 'occurrence_rescheduled',
          objectConfidence: 'low', eventConfidence: 'low', evidenceRefs: [], sourceVersionRefs: [],
          target: { occurrenceId: node.occurrenceId }, temporal: node.temporal }) === key)
      if (node) return node
    }
  }
  return undefined
}

export function gmailReconciliationStateForRecord(record: GmailSemanticRecord, snapshot?: PJSDASSnapshot): GmailReconciliationState | undefined {
  if (snapshot?.data.decisionRequests?.some(request => (request.state === 'open' || request.state === 'expired')
    && request.payloadBinding.source.kind === record.observation.source.kind
    && request.payloadBinding.source.sourceId === record.observation.source.sourceId
    && request.payloadBinding.source.sourceRecordId === record.observation.source.sourceRecordId)) return 'UNRESOLVED'
  const latestAccounted = snapshot?.data.timeline?.filter(item => item.ingestion
    && item.ingestion.sourceKind === record.observation.source.kind
    && item.ingestion.sourceId === record.observation.source.sourceId
    && item.ingestion.sourceRecordId === record.observation.source.sourceRecordId)
    .sort((a, b) => b.ingestion!.accountedAt.localeCompare(a.ingestion!.accountedAt))[0]?.ingestion
  if (latestAccounted?.outcome === 'unresolved') return 'UNRESOLVED'
  if (committedInterviewReschedule(record, snapshot)) return 'ACTION_REQUIRED'
  const relevant = Boolean(record.recruitingRelevant || record.gaps.length || record.observation.candidates.length)
  if (!relevant) return undefined
  const candidates = record.observation.candidates.filter(candidate => !snapshot || !dismissedSemanticCandidate(snapshot, record.observation, candidate))
  const unresolvedTarget = candidates.some((candidate) =>
    !candidate.target?.opportunityId
    && !['reminder_cancelled'].includes(candidate.kind))
  if (record.gaps.length > 0 || record.issueKinds?.some(kind => kind !== 'business_ambiguity') || unresolvedTarget) return 'UNRESOLVED'
  if (candidates.some((candidate) => candidate.kind === 'abandon_opportunity' || candidate.kind === 'external_withdrawal')) {
    return 'EXPLICITLY_DECLINED'
  }
  if (candidates.some((candidate) => candidate.kind === 'occurrence_completed')) return 'COMPLETED'
  if (candidates.some((candidate) => candidate.kind === 'occurrence_cancelled'
    || candidate.kind === 'process_event' && candidate.eventType === 'rejection')) return 'CLOSED'
  if (candidates.some((candidate) =>
    candidate.kind === 'opportunity_deadline'
      || candidate.kind === 'occurrence_rescheduled'
      || candidate.kind === 'manual_action'
      || candidate.kind === 'reminder_intent'
      || candidate.kind === 'process_event' && ['assessment_invite', 'written_test_invite', 'interview_invite', 'offer'].includes(candidate.eventType))) {
    return 'ACTION_REQUIRED'
  }
  if (candidates.some((candidate) => candidate.kind === 'application_submitted'
    || candidate.kind === 'process_event' && candidate.eventType === 'status_update')) return 'WAITING'
  return 'NO_ACTION'
}

function reconciliationBatchAccumulator(
  records: GmailSemanticRecord[],
  scannedCount: number,
  unavailableMessageCount: number,
  now: Date,
  snapshot: PJSDASSnapshot,
): GmailReconciliationAccumulator {
  const stateCounts = emptyGmailReconciliationAccumulator().stateCounts
  const gmailOpportunityIds = new Set<string>()
  let gmailOnlyCount = 0
  let fixedOrHardWithin7DaysCount = 0
  const horizon = now.getTime() + 7 * 86_400_000

  for (const record of records) {
    const state = gmailReconciliationStateForRecord(record, snapshot)
    if (!state) continue
    stateCounts[state] += 1
    const committed = state === 'ACTION_REQUIRED' ? committedInterviewReschedule(record, snapshot) : undefined
    let hasBoundTarget = Boolean(committed)
    if (committed?.opportunityId) {
      gmailOpportunityIds.add(committed.opportunityId)
      const instant = Date.parse(committed.temporal.startAt ?? '')
      if (committed.temporal.shape === 'fixed_range' && instant >= now.getTime() && instant <= horizon) fixedOrHardWithin7DaysCount += 1
    }
    const candidates = record.observation.candidates.filter(candidate => !dismissedSemanticCandidate(snapshot, record.observation, candidate))
    for (const candidate of candidates) {
      if (candidate.target?.opportunityId) {
        hasBoundTarget = true
        gmailOpportunityIds.add(candidate.target.opportunityId)
      }
      if (candidate.kind === 'process_event') {
        const temporal = candidate.temporal
        const instant = temporal?.latestStartAt ?? temporal?.deadlineAt ?? temporal?.startAt ?? candidate.dueAt
        const value = instant ? new Date(instant).getTime() : NaN
        if (Number.isFinite(value) && value >= now.getTime() && value <= horizon
          && (candidate.timingMode === 'deadline'
            || temporal?.shape === 'fixed_range'
            || temporal?.shape === 'deadline'
            || temporal?.shape === 'availability_window')) {
          fixedOrHardWithin7DaysCount += 1
        }
      }
    }
    if (!hasBoundTarget && candidates.length > 0) gmailOnlyCount += 1
  }

  return {
    scannedCount,
    recruitingRelevantCount: GMAIL_RECONCILIATION_STATES.reduce((sum, state) => sum + stateCounts[state], 0),
    stateCounts,
    gmailOnlyCount,
    fixedOrHardWithin7DaysCount,
    unavailableMessageCount,
    gmailOpportunityIds: [...gmailOpportunityIds],
  }
}

function finalReconciliationSummary(
  snapshot: import('../src/snapshot.js').PJSDASSnapshot,
  aggregate: GmailReconciliationAccumulator,
  now: Date,
): GmailReconciliationSummary {
  const liveProcesses = recentLiveProcesses(snapshot, now)
  const gmailOpportunityIds = new Set(aggregate.gmailOpportunityIds)
  const pjsdasOnlyCount = liveProcesses.filter((process) =>
    !process.opportunityId || !gmailOpportunityIds.has(process.opportunityId)).length
  return {
    scannedCount: aggregate.scannedCount,
    recruitingRelevantCount: aggregate.recruitingRelevantCount,
    stateCounts: aggregate.stateCounts,
    actionableCount: aggregate.stateCounts.ACTION_REQUIRED,
    unresolvedCount: aggregate.stateCounts.UNRESOLVED,
    gmailOnlyCount: aggregate.gmailOnlyCount,
    pjsdasOnlyCount,
    fixedOrHardWithin7DaysCount: aggregate.fixedOrHardWithin7DaysCount,
    liveProcessCount: liveProcesses.length,
    unavailableMessageCount: aggregate.unavailableMessageCount,
  }
}

export function reconciliationRecordVersion(record: GmailSemanticRecord): GmailSemanticRecord {
  const sourceRecordId = record.observation.source.sourceRecordId
  return {
    ...record,
    observation: {
      ...record.observation,
      inputId: `gmail:${sourceRecordId}:${GMAIL_RECONCILIATION_PARSER_VERSION}`,
      source: {
        ...record.observation.source,
        sourceVersion: GMAIL_RECONCILIATION_PARSER_VERSION,
      },
      candidates: record.observation.candidates.map((candidate) => ({
        ...candidate,
        sourceVersionRefs: [`${sourceRecordId}:${GMAIL_RECONCILIATION_PARSER_VERSION}`],
      })),
    },
  }
}

export async function runGmailReconciliationForBinding(options: {
  binding: GmailAutomationBinding
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  refreshLifecycle?: GoogleRefreshLifecycle
  fetchImpl?: typeof fetch
  now?: () => Date
  forceStart?: boolean
  execution?: { observer?: GmailExecutionObserver; beforeWorkspaceWrite: () => Promise<void>; canProcessNextMessage?: () => boolean }
}): Promise<GmailReconciliationRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now?.() ?? new Date()
  const checkedAt = now.toISOString()
  if (!options.binding.gmailReconciliationState
    && !options.binding.gmailReconciliationRequestedAt
    && !options.forceStart) {
    throw new WorkspaceSourceError('GMAIL_RECONCILIATION_NOT_REQUESTED', 'No Gmail reconciliation cycle is pending.', false)
  }
  if (options.binding.gmailIntakeConsentVersion !== 'uu06-v1') {
    throw new WorkspaceSourceError('GMAIL_RECONCILIATION_CONSENT_REQUIRED', 'Gmail reconciliation requires the current explicit Gmail intake consent.', false)
  }
  if (!options.binding.grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
    throw new WorkspaceSourceError('GOOGLE_GMAIL_SCOPE_MISSING', 'Gmail reconciliation requires the Gmail read-only permission.', false)
  }

  options.execution?.observer?.phase('token_refresh')
  const refreshToken = await decryptSecret(options.binding.refreshTokenCiphertext, options.tokenEncryptionKey)
  const accessToken = await refreshGoogleAccessToken(refreshToken, {
    ...options.refreshLifecycle,
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
        reuseReadPreimage: true,
        timezone: 'Asia/Shanghai',
        fetchImpl,
      })
    : createDriveWorkspaceSource({ getAccessToken: () => accessToken, fetchImpl, timezone: 'Asia/Shanghai' })
  options.execution?.observer?.phase('workspace_read')
  const workspace = await source.read()
  const priorState = options.binding.gmailReconciliationState
  options.execution?.observer?.phase('gmail_list')
  const batch = await fetchGmailReconciliationBatch({
    accessToken,
    continuation: priorState,
    maxMessages: RECONCILIATION_PARSE_SLICE_SIZE,
    fetchImpl,
    now,
  })
  options.execution?.observer?.phase('message_parse')
  const fetchedCount = batch.scannedCount
  const messagesById = new Map(batch.messages.map(message => [message.id, message]))
  const records: GmailSemanticRecord[] = []
  let processedCount = 0
  for (const id of batch.selectedMessageIds) {
    if (processedCount >= RECONCILIATION_PARSE_SLICE_SIZE || options.execution?.canProcessNextMessage?.() === false) break
    const message = messagesById.get(id)
    if (message) {
      const record = gmailSemanticRecordFromMessage(message, workspace.snapshot.data.opportunities, now)
      if (record) records.push(reconciliationRecordVersion(record))
    }
    processedCount += 1
    options.execution?.observer?.processed()
  }
  if (batch.selectedMessageIds.length && !processedCount) {
    throw new WorkspaceSourceError('BUDGET_EXHAUSTED', 'Gmail reconciliation has no budget for a complete message; continuation was preserved.', true)
  }
  // Commit only whole-message prefixes. Already fetched but unparsed IDs stay
  // ahead of the provider continuation, including after a lost finalization.
  batch.pendingMessageIds = [...batch.selectedMessageIds.slice(processedCount), ...batch.pendingMessageIds]
  batch.selectedMessageIds = batch.selectedMessageIds.slice(0, processedCount)
  batch.unavailableMessageIds = batch.unavailableMessageIds.filter(id => batch.selectedMessageIds.includes(id))
  batch.scannedCount = processedCount
  batch.coverageComplete = !batch.pendingMessageIds.length && !batch.nextPageToken
  for (const sourceRecordId of batch.unavailableMessageIds) {
    records.push({
      receivedAt: checkedAt,
      recruitingRelevant: true,
      gaps: ['Gmail reconciliation found a source record whose payload was unavailable; no recruiting facts were inferred.'],
      issueKinds: ['transport_gap'],
      observation: {
        contractVersion: 1,
        inputId: `gmail:${sourceRecordId}:reconciliation-unavailable-v1`,
        source: {
          kind: 'gmail', sourceId: GMAIL_SOURCE_ID, sourceRecordId,
          sourceVersion: 'reconciliation-unavailable-v1', observedAt: checkedAt,
          timezone: workspace.context.timezone ?? 'Asia/Shanghai',
        },
        statementMode: 'assertion',
        candidates: [],
      },
    })
  }

  const batchIdentity = [
    GMAIL_RECONCILIATION_PARSER_VERSION,
    batch.cycleStartedAt,
    priorState?.pageToken ?? 'start',
    ...batch.selectedMessageIds,
  ].join('|')
  const runId = `gmail:reconcile:${stableIngestionHash(batchIdentity)}`
  options.execution?.observer?.phase('semantic_apply')
  const result = applyGmailSemanticBatch(workspace.snapshot, {
    runId,
    sourceId: GMAIL_SOURCE_ID,
    checkedAt,
    records,
    authorized: true,
    workspaceRevision: workspace.context.workspaceVersion,
    reconcileExisting: true,
  })


  const batchAccumulator = reconciliationBatchAccumulator(
    records,
    batch.scannedCount,
    batch.unavailableMessageIds.length,
    now,
    result.snapshot,
  )
  const aggregate = mergeGmailReconciliationAccumulator(
    priorState?.aggregate ?? emptyGmailReconciliationAccumulator(),
    batchAccumulator,
  )
  if (aggregate.scannedCount > RECONCILIATION_MAX_MESSAGES) {
    throw new WorkspaceSourceError(
      'GMAIL_RECONCILIATION_LIMIT_EXCEEDED',
      `Gmail reconciliation exceeded the bounded ${RECONCILIATION_MAX_MESSAGES}-record cycle limit.`,
      false,
    )
  }
  const summary = finalReconciliationSummary(result.snapshot, aggregate, now)
  const continuation: GmailReconciliationContinuationState | undefined = batch.coverageComplete
    ? undefined
    : {
        version: 1,
        cycleStartedAt: batch.cycleStartedAt,
        pageToken: batch.nextPageToken,
        pendingMessageIds: batch.pendingMessageIds,
        aggregate,
      }


  if (batch.coverageComplete && !result.alreadyApplied) {
    const proof: GmailReconciliationProof = {
      version: 1,
      scannedCount: summary.scannedCount,
      recruitingRelevantCount: summary.recruitingRelevantCount,
      stateCounts: summary.stateCounts,
      gmailOnlyCount: summary.gmailOnlyCount,
      pjsdasOnlyCount: summary.pjsdasOnlyCount,
      fixedOrHardWithin7DaysCount: summary.fixedOrHardWithin7DaysCount,
      liveProcessCount: summary.liveProcessCount,
      unavailableMessageCount: summary.unavailableMessageCount,
    }
    result.snapshot.data.timeline = [...(result.snapshot.data.timeline ?? []), {
      id: `timeline:gmail-reconciliation:${stableIngestionHash(batch.cycleStartedAt)}`,
      kind: 'gmail_reconciliation_completed',
      category: 'data',
      source: 'gmail',
      occurredAt: checkedAt,
      recordedAt: checkedAt,
      title: `Gmail reconciliation｜${summary.recruitingRelevantCount} recruiting / ${summary.scannedCount} scanned`,
      detail: `ACTION_REQUIRED:${summary.actionableCount} · UNRESOLVED:${summary.unresolvedCount} · Gmail-only:${summary.gmailOnlyCount} · TodayAction-only:${summary.pjsdasOnlyCount} · hard/fixed≤7d:${summary.fixedOrHardWithin7DaysCount}`,
      sourceRef: `gmail:reconciliation:${batch.cycleStartedAt}`,
      gmailReconciliation: proof,
    }]
    result.snapshot.exportedAt = checkedAt
    validateSnapshot(result.snapshot)
  }

  let workspaceVersion = workspace.context.workspaceVersion
  if (!result.alreadyApplied) {
    await options.execution?.beforeWorkspaceWrite()
    options.execution?.observer?.phase('workspace_commit')
    const written = await requireWritableWorkspaceSource(source).write({
      snapshot: result.snapshot,
      expectedWorkspaceVersion: workspace.context.workspaceVersion,
      updatedByDevice: 'gmail-reconciliation-worker',
      command: {
        commandId: runId,
        operation: 'gmail_semantic_intake',
        payload: {
          sourceId: GMAIL_SOURCE_ID,
          reconciliation: true,
          cycleStartedAt: batch.cycleStartedAt,
          batchScannedCount: batch.scannedCount,
          cycleComplete: batch.coverageComplete,
        },
        provenance: { sourceId: GMAIL_SOURCE_ID, adapterVersion: GMAIL_RECONCILIATION_PARSER_VERSION },
        compensation: { ...result.compensation },
        effectiveTime: checkedAt,
      },
    })
    workspaceVersion = written.context.workspaceVersion
  }

  options.execution?.observer?.phase('checkpoint')
  return {
    userId: options.binding.userId,
    checkedAt,
    alreadyApplied: result.alreadyApplied,
    workspaceVersion,
    cycleComplete: batch.coverageComplete,
    continuation,
    summary,
    metrics: {
      status: 'completed',
      mode: 'reconciliation',
      receivedCount: fetchedCount,
      accountedCount: batch.scannedCount,
      unresolvedCount: batchAccumulator.stateCounts.UNRESOLVED,
      recordGapCount: batch.unavailableMessageIds.length,
    },
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

/** Keep only the sender's current body before an explicit quoted-thread boundary. */
function conditionalCompletionDisclaimer(value: string) {
  return /(?:如|如果|若|if).{0,24}(?:已完成|已经完成|completed).{0,24}(?:请忽略|忽略|ignore)/i.test(value)
}

function conditionalFutureInterviewReference(value: string) {
  return /(?:如|如果|若|未按时|未完成).{0,48}(?:无法|不能|才能|方可|进入).{0,24}(?:后续|下一轮)?.{0,10}(?:面试|ai面|业务面|hr面)/i.test(value)
}

/** Drop only complete, known procedural constructions; all mixed/unknown text survives. */
function recruitingInstructionOnly(value: string) {
  const text = value.trim().replace(/\s+/g, '')
  // These closed grammars cannot swallow a second assertion, date, invitation,
  // cancellation or explanatory suffix. Equipment keywords alone prove nothing.
  return /^(?:面试|笔试|测评)(?:前|时|中|过程中|期间)(?:请|务必|建议)?(?:提前)?(?:检查|检测|测试|确认|开启|保持|确保)(?:(?:摄像头|麦克风|设备|网络|浏览器)(?:和|及|、)?)+(?:正常|正常运行|畅通|稳定|可用)?$/.test(text)
    || /^(?:面试|笔试|测评)(?:时|中|过程中|期间)(?:请勿|勿|不要|避免)(?:切换页面|切换浏览器页面|切换窗口|切换标签页)$/.test(text)
    || /^如遇(?:面试|笔试|测评)(?:设备|网络|浏览器)(?:问题|故障)请联系(?:技术客服|客服|技术支持)$/.test(text)
    || /^请于[0-9年月日/:：+T.Z-]+完成(?:面试|笔试|测评)(?:设备检查|设备检测|网络测试)$/.test(text)
}

function candidateHasOpportunityIdentity(candidate: SemanticCandidate) {
  const target = candidate.target
  return Boolean(target?.opportunityId || target?.company?.trim() || target?.role?.trim())
}

function currentGmailAssertion(raw: string) {
  const current: string[] = []
  let quoted = false
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(?:>|转发邮件|原始邮件|Original Message|On .+ wrote:|引用\s*[:：]|原话\s*[:：]|quote\s*[:：])/i.test(line)) {
      quoted = true
      break
    }
    const inlineQuote = /\s+(?:引用|原话|quote)\s*[:：]/i.exec(line)
    if (inlineQuote) {
      current.push(line.slice(0, inlineQuote.index))
      quoted = true
      break
    }
    current.push(line)
  }
  return { text: current.join('\n').trim(), quoted }
}

function gmailSourceUrlSpans(value: string) {
  return [...value.matchAll(/https?:\/\/[^\s<>，。；]+/gi)].map(match => {
    // A Chinese request immediately after an ASCII comma is prose, not a
    // meeting URL suffix. Ordinary commas inside the URL remain untouched.
    const boundary = /[,;](?=请于|请在|请|确认|回执)/.exec(match[0])
    const length = boundary?.index ?? match[0].length
    return { start: match.index!, end: match.index! + length }
  })
}
function gmailAssertionWithoutUrls(value: string) {
  let assertion = value
  for (const span of gmailSourceUrlSpans(value).reverse()) assertion = assertion.slice(0, span.start) + ' ' + assertion.slice(span.end)
  return assertion
}
function attendanceConfirmationDeadline(value: string) {
  const assertion = gmailAssertionWithoutUrls(value)
  return /(?:确认|回执).{0,16}(?:是否)?参加|(?:是否)?参加.{0,16}(?:确认|回执)/.test(assertion)
    && /(?:前|截止|最晚|最迟)/.test(assertion)
}

/** Separate only explicit comma-delimited RSVP requests. Preserve the original
 * non-RSVP bytes (including URL commas) and keep RSVP identity evidence. */
function splitAttendanceConfirmation(value: string): string[] {
  if (!attendanceConfirmationDeadline(value)) return [value]
  const urls = gmailSourceUrlSpans(value)
  const commas = [...value.matchAll(/[，,]/g)].map(match => match.index!)
    .filter(index => !urls.some(span => index >= span.start && index < span.end))
  const boundaries = [-1, ...commas, value.length]
  const clauses = boundaries.slice(1).map((end, index) => ({ start: boundaries[index]! + 1, end }))
  const requests = clauses.filter(clause => attendanceConfirmationDeadline(value.slice(clause.start, clause.end)))
  if (!requests.length) return [value]
  const result: string[] = []
  let start = 0
  for (const request of requests) {
    const preceding = value.slice(start, Math.max(start, request.start - 1)).trim()
    if (preceding) result.push(preceding)
    result.push(value.slice(request.start, request.end).trim())
    start = request.end + 1
  }
  const remaining = value.slice(start).trim()
  if (remaining) result.push(remaining)
  return result
}

/** A labelled invitation block is one assertion, not one invitation per field.
 * Only adjacent, closed labels may contribute identity or timing. */
function gmailAssertionPieces(pieces: string[]) {
  const result = [...pieces]
  for (let start = 0; start < result.length; start += 1) {
    if (!/^(?:面试|笔试|测评)详情如下[:：]?$/.test(result[start]!)) continue
    const type = /^(面试|笔试|测评)/.exec(result[start]!)![1]!
    let end = start + 1
    while (end < result.length && new RegExp(`^${type}(?:职位|岗位|时间|形式|地址|地点)\\s*[:：]`).test(result[end]!)) end += 1
    const fields = result.slice(start + 1, end)
    const labels = fields.map(field => field.split(/[:：]/)[0])
    if (fields.length < 2 || new Set(labels).size !== labels.length) continue
    // A preceding invitation supplies company identity; unknown prose and
    // another event are never traversed to find an identity.
    const previous = result[start - 1]
    const includePrevious = Boolean(previous && new RegExp(`(?:邀请|诚邀|欢迎).{0,12}(?:参加)?${type}`).test(previous)
      && !/(?:取消|撤销|已完成|改期|改为|调整|另|再次|下一轮|第二|第三)/.test(previous))
    const first = includePrevious ? start - 1 : start
    result[first] = result.slice(first, end).join('；')
    for (let index = first + 1; index < end; index += 1) result[index] = ''
    start = end - 1
  }
  return result
}

type GmailEventCandidate = Extract<SemanticCandidate, { kind: 'process_event' }>
function gmailEventIdentity(candidate: GmailEventCandidate) {
  const target = candidate.target
  return JSON.stringify([target?.opportunityId ?? null, target?.company ?? null, target?.role ?? null])
}
function gmailEventTemporal(candidate: GmailEventCandidate) {
  const temporal = candidate.temporal
  return JSON.stringify([temporal?.shape, temporal?.startAt, temporal?.endAt, temporal?.deadlineAt,
    temporal?.date, temporal?.latestStartAt, candidate.dueAt, candidate.timingMode])
}

/** Coalesce only repeated descriptions of one evidenced event; never choose a
 * date, role, round or supplementary detail between competing assertions. */
function coalesceGmailEventDescriptions(candidates: SemanticCandidate[], pieces: string[]) {
  const events = candidates.filter((candidate): candidate is GmailEventCandidate => candidate.kind === 'process_event')
  const removed = new Set<SemanticCandidate>()
  const merge = (anchor: GmailEventCandidate, detail: GmailEventCandidate) => {
    anchor.evidenceRefs = [...new Set([...anchor.evidenceRefs, ...detail.evidenceRefs])]
    anchor.sourceVersionRefs = [...new Set([...anchor.sourceVersionRefs, ...detail.sourceVersionRefs])]
    anchor.location ??= detail.location
    anchor.joinUrl ??= detail.joinUrl
    removed.add(detail)
  }
  const conflicts = (a: GmailEventCandidate, b: GmailEventCandidate) =>
    Boolean(a.location && b.location && a.location !== b.location || a.joinUrl && b.joinUrl && a.joinUrl !== b.joinUrl)
  const independent = (candidate: GmailEventCandidate) => /(?:另一次|另外|再次|下一轮|第二|第三|一面|二面|三面|终面|或|或者|另行|待定|后续通知|改期|改为|调整)/.test(pieces[Number(candidate.id.split(':')[1])] ?? '')
  for (const candidate of events) {
    if (removed.has(candidate) || !candidate.temporal || independent(candidate)) continue
    for (const detail of events) {
      if (detail === candidate || removed.has(detail) || independent(detail) || conflicts(candidate, detail)
        || detail.eventType !== candidate.eventType || gmailEventIdentity(detail) !== gmailEventIdentity(candidate)) continue
      if (detail.temporal && gmailEventTemporal(detail) === gmailEventTemporal(candidate)
        && (candidateHasOpportunityIdentity(candidate) || pieces[Number(candidate.id.split(':')[1])] === pieces[Number(detail.id.split(':')[1])])) merge(candidate, detail)
    }
  }
  for (const detail of events) {
    if (removed.has(detail) || detail.temporal || independent(detail)) continue
    const raw = pieces[Number(detail.id.split(':')[1])] ?? ''
    // An unresolved date or alternative anchor is evidence of uncertainty,
    // not a duplicate invitation which may borrow the other event's date.
    if (/20\d{2}|\d{1,2}[:：]\d{2}|\d+\s*(?:年|月|日|号|点|分钟|天)|明天|后天|今天|周[一二三四五六日天]|小时|hours?|截止|最晚|确认|回执/.test(raw)) continue
    const anchors = events.filter(candidate => !removed.has(candidate) && candidate.temporal && !independent(candidate)
      && candidate.eventType === detail.eventType && gmailEventIdentity(candidate) === gmailEventIdentity(detail)
      && candidateHasOpportunityIdentity(candidate) && !conflicts(candidate, detail))
    if (anchors.length === 1) merge(anchors[0]!, detail)
  }
  return candidates.filter(candidate => !removed.has(candidate))
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
  if (!message.id) return undefined
  const excluded = message.labelIds?.some((label) => label === 'SPAM' || label === 'TRASH')
  const content = excluded ? { text: '', uninterpretedHtml: false } : messageBodyContent(message.payload, true)
  const body = content.text
  const subject = excluded ? '' : header(message.payload, 'subject')
  const sourceText = excluded ? '' : body || subject || cleanText(message.snippet)
  const current = currentGmailAssertion(sourceText)
  const text = current.text
  const boundedRescheduleSource = /面试改期通知\s*[:：]\s*原定/.test(text)
  const boundedSourceTime = boundedRescheduleSource ? boundGmailSourceInstant(message, now) : undefined
  const originalHeaderTime = Date.parse(header(message.payload, 'date'))
  const originalInternalTime = message.internalDate ? Number(message.internalDate) : NaN
  const originalTime = Number.isFinite(originalInternalTime) && !Number.isNaN(new Date(originalInternalTime).getTime())
    ? originalInternalTime : originalHeaderTime
  const originalReceivedAt = boundedRescheduleSource ? boundedSourceTime
    : Number.isFinite(originalTime) ? new Date(originalTime).toISOString() : undefined
  // The legacy classifier may convert a finite but out-of-range number to ISO.
  // For an invalid bound-source clock, classify metadata using a copy without
  // untrusted time fields. This supplies no fact time: assertedAt stays absent,
  // and the explicit interpretation gap below prevents every business write.
  const classificationMessage = boundedRescheduleSource && !boundedSourceTime
    ? { ...message, internalDate: undefined, payload: { ...message.payload,
        headers: message.payload?.headers?.filter(item => item.name?.toLowerCase() !== 'date') } }
    : message
  const prior = gmailObservationFromMessage(classificationMessage, opportunities, now)
  if (!prior) return undefined
  const legacy = { ...prior, receivedAt: originalReceivedAt ?? prior.receivedAt }
  const interpretationGaps: string[] = originalReceivedAt ? [] : ['Original message timestamp is unavailable; automatic facts require clarification.']
  if (content.uninterpretedHtml) interpretationGaps.push('HTML body exceeds the supported parsing complexity or could not be interpreted; inspect the original mail.')
  const businessAmbiguities: string[] = []
  const capabilityBoundaries: string[] = []
  const visit = (part: GmailPart | undefined) => {
    if (!part) return
    if (part.filename) capabilityBoundaries.push('Attachment content is NOT_SUPPORTED; inspect the original mail if it contains material details.')
    for (const child of part.parts ?? []) visit(child)
  }
  if (!excluded) visit(message.payload)
  if (/https?:\/\//i.test(text)) capabilityBoundaries.push('Linked pages are NOT_SUPPORTED; no link is opened or treated as verified source content.')
  if (body.length >= 12_000) interpretationGaps.push('Message exceeds the bounded body limit; remaining content was not interpreted.')
  const nonAssertion = !text && current.quoted || /^(?:示例|假设|假如|hypothetical|for example)\b/i.test(text)
  let fragmentText = text
  for (const span of gmailSourceUrlSpans(text).reverse()) {
    fragmentText = fragmentText.slice(0, span.start) + text.slice(span.start, span.end).replaceAll(';', '%3B') + fragmentText.slice(span.end)
  }
  const allPieces = fragmentText.split(/[；;。\n]+/).map((item) => item.trim()).filter(Boolean).flatMap(splitAttendanceConfirmation)
  const boundedPieces = gmailAssertionPieces(allPieces.slice(0, GMAIL_FRAGMENT_PARSE_LIMIT))
  if (allPieces.length > GMAIL_FRAGMENT_PARSE_LIMIT) {
    interpretationGaps.push(`Message exceeds the bounded ${GMAIL_FRAGMENT_PARSE_LIMIT}-fragment interpretation limit.`)
  }
  const parsedAt = new Date(legacy.receivedAt)
  const assertionText = boundedPieces.filter(piece => !recruitingInstructionOnly(piece)).join('；')
  const whole = parseRecruitingNotification([subject, assertionText].join('\n'), opportunities, parsedAt)
  const assertionParsed = parseRecruitingNotification(assertionText, opportunities, parsedAt)
  const subjectParsed = parseRecruitingNotification(subject, opportunities, parsedAt)
  const subjectType = /interview invitation/i.test(subject) ? 'interview_invite'
    : /(?:assessment|test) invitation/i.test(subject) ? 'assessment_invite'
    : !recruitingInstructionOnly(subject) && subjectParsed.type && subjectParsed.type !== 'other' && subjectParsed.confidence.type === 'high' ? subjectParsed.type : undefined
  const fragmentParseCache = new Map<string, ReturnType<typeof parseRecruitingNotification>>()
  const parsedPieces = boundedPieces.map((piece) => {
    const instructionOnly = recruitingInstructionOnly(piece)
    let parsed = fragmentParseCache.get(piece)
    if (!parsed) {
      // Closed procedural clauses have no business target to match against
      // every opportunity. Cache repeated wording within this source only.
      const labelledBlock = /(?:^|；)(?:面试|笔试|测评)详情如下[:：]?；/.test(piece)
        && /(?:^|；)(?:面试|笔试|测评)(?:职位|岗位)[:：]/.test(piece)
      const assertionPiece = gmailAssertionWithoutUrls(piece)
      parsed = parseRecruitingNotification(instructionOnly ? '' : labelledBlock ? [subject, assertionPiece].join('\n') : assertionPiece,
        instructionOnly ? [] : opportunities, parsedAt)
      fragmentParseCache.set(piece, parsed)
    }
    return { piece, instructionOnly, parsed }
  })
  // Only the subject or a leading identity-only header can supply omitted
  // identity. Never borrow a target from an independent event elsewhere.
  const firstPiece = parsedPieces[0]
  const identityHeader = firstPiece && !firstPiece.instructionOnly
    && firstPiece.parsed.type === 'other' ? firstPiece.parsed : undefined
  const context = subjectParsed.opportunity ? subjectParsed : identityHeader
  const contextTarget = context?.opportunity
  const contextSafe = contextTarget && [subject, ...parsedPieces.map(item => item.piece)]
    .every(value => notificationIdentityCompatible(value, contextTarget, opportunities))
  const bodyHasEvent = parsedPieces.some(({ parsed, instructionOnly }) =>
    !instructionOnly && parsed.type && parsed.type !== 'other' && parsed.confidence.type !== 'low')
  const pieces = !bodyHasEvent && subjectType
    ? [{ piece: assertionText, parsed: { ...whole, opportunity: assertionParsed.opportunity, candidates: assertionParsed.candidates, confidence: { ...whole.confidence, opportunity: assertionParsed.confidence.opportunity } }, instructionOnly: false }]
    : parsedPieces
  const timedContextTypes = [...new Set(pieces.filter(item => !item.instructionOnly).map(({ parsed }) => parsed.type)
    .filter((type) => type && requiresTiming(type)))]
  const deadlineContextType = timedContextTypes.length === 1 ? timedContextTypes[0] : undefined
  const candidates: SemanticCandidate[] = []
  let pendingInterviewReschedule: GmailSemanticRecord['pendingInterviewReschedule']
  if (boundedRescheduleSource && (!boundedSourceTime || boundedSourceTime !== originalReceivedAt)) {
    interpretationGaps.push('Bound reschedule requires a valid provider timestamp or one complete, explicitly offset RFC Date header; source clock remains unresolved.')
  }
  for (const [index, item] of pieces.entries()) {
    const { piece, parsed } = item
    if (item.instructionOnly || conditionalCompletionDisclaimer(piece)) continue
    if (attendanceConfirmationDeadline(piece)) {
      businessAmbiguities.push('Attendance confirmation is a separate request; its deadline is not the test or interview time and no attendance choice was made.')
      continue
    }
    const submissionDeadline = /(?:提交|交卷|submission|submit).{0,12}(?:截止|最晚|deadline|by)|(?:截止|deadline).{0,12}(?:提交|交卷|submission|submit)/i.test(piece)
    const previous = pieces[index - 1]
    // A submission deadline immediately following a directly identified test
    // window is a dependent detail. Never search across another fragment or
    // propagate an identity that the previous fragment itself inherited.
    const precedingWindow = submissionDeadline && parsed.type === 'other' && previous?.parsed.opportunity
      && !previous.instructionOnly && !conditionalCompletionDisclaimer(previous.piece)
      && ['written_test_invite', 'assessment_invite'].includes(previous.parsed.type ?? '')
      && previous.parsed.type === deadlineContextType
      && !/(?:取消|撤销|已完成|已经完成|已提交|改期|改为|调整|cancel|completed|reschedul)/i.test(previous.piece)
      && notificationIdentityCompatible(piece, previous.parsed.opportunity, opportunities)
      && notificationIdentityCanInherit(piece, previous.parsed.opportunity)
      && resolveSourceTemporal(previous.piece, { receivedAt: originalReceivedAt ?? '', timezone: 'Asia/Shanghai', mode: previous.parsed.timingMode })?.shape === 'availability_window'
      ? previous.parsed : undefined
    const inherited = contextSafe && contextTarget
      && notificationIdentityCompatible(piece, contextTarget, opportunities)
      && notificationIdentityCanInherit(piece, contextTarget) ? contextTarget : undefined
    const selected = parsed.opportunity ?? inherited ?? precedingWindow?.opportunity
    const plausible = parsed.candidates
      .filter(item => item.score >= 40 && notificationIdentityCompatible(piece, item.opportunity, opportunities))
    const commonCompany = commonNotificationCompany(piece, plausible.map(item => item.opportunity))
    const commonRole = plausible.length >= 2 && plausible.every(item =>
      item.opportunity.role === plausible[0]?.opportunity.role) ? plausible[0]?.opportunity.role : undefined
    const eventType = submissionDeadline && deadlineContextType ? deadlineContextType
      : parsed.type && parsed.type !== 'other' ? parsed.type : !bodyHasEvent ? subjectType : undefined
    if (eventType === 'interview_invite' && conditionalFutureInterviewReference(piece)) continue
    const eventConfidence = !originalReceivedAt ? 'low' as const : eventType === parsed.type ? parsed.confidence.type : 'high' as const
    const application = /(?:投递|申请).{0,12}(?:成功|已收到)|(?:application).{0,20}(?:received|submitted|confirmed)/i.test(piece)
    if (!application && (!eventType || parsed.confidence.type === 'low' && eventType === parsed.type)) continue
    const evidenceRef = `gmail:primary:${message.id}:fragment:${index}`
    const base = {
      id: `fragment:${index}`,
      // A source-only ambiguity is a user choice only when the message itself
      // names a bounded business target. Keep the common identity for the
      // shared resolver; an unanchored parser guess stays coverage debt.
      target: selected ? { opportunityId: selected.id }
        : commonCompany || (commonRole && notificationIdentityText(piece).includes(commonRole))
          ? { company: commonCompany, role: commonRole && notificationIdentityText(piece).includes(commonRole) ? commonRole : undefined } : undefined,
      objectConfidence: selected ? (parsed.opportunity ? parsed.confidence.opportunity : inherited ? context!.confidence.opportunity : precedingWindow!.confidence.opportunity) : 'low' as const,
      eventConfidence: !originalReceivedAt ? 'low' as const : application ? 'high' as const : eventConfidence,
      evidenceRefs: [evidenceRef], sourceVersionRefs: [`${message.id}:uu06-v1`],
    }
    if (boundedRescheduleSource) {
      businessAmbiguities.push(GMAIL_RESCHEDULE_TIME_GAP)
      // Do not let unsupported suffixes turn this old/new notice into a
      // completion/cancellation or commit a parsed prefix of a mixed message.
      if (selected && !nonAssertion && body && boundedSourceTime === originalReceivedAt && boundedSourceTime
        && boundedPieces.length === 1 && text.length <= 2048
        && [`${selected.company} ${selected.role} 招聘进展`, `${selected.company} ${selected.role} 面试改期通知`].includes(subject.trim())) {
        pendingInterviewReschedule = { text, opportunityId: selected.id }
      }
      continue
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
    const temporal = resolveSourceTemporal(gmailAssertionWithoutUrls(piece), { receivedAt: originalTimestamp,
      timezone: 'Asia/Shanghai', mode: submissionDeadline ? 'deadline' : parsed.timingMode })
    const dueAt = temporal?.startAt ?? temporal?.deadlineAt ?? temporal?.date
    const duePrecision = temporal?.precision
    if (occurrenceKind && /改期|改为|调整为|reschedul/i.test(piece)) {
      if (temporal) {
        candidates.push({ ...base, kind: 'occurrence_rescheduled', temporal, temporalConfidence: 'high', target: { ...base.target, occurrenceKind } })
      } else businessAmbiguities.push(GMAIL_RESCHEDULE_TIME_GAP)
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
  const highTimedUnresolvedEventTypes = new Set(
    candidates
      .filter((candidate) => candidate.kind === 'process_event'
        && !candidateHasOpportunityIdentity(candidate)
        && candidate.temporalConfidence === 'high'
        && Boolean(candidate.temporal || candidate.dueAt))
      .map((candidate) => candidate.kind === 'process_event' ? candidate.eventType : undefined)
      .filter((value): value is ProcessEventType => Boolean(value)),
  )
  if (highTimedUnresolvedEventTypes.size > 0) {
    const retained = candidates.filter((candidate) => !(candidate.kind === 'process_event'
      && !candidateHasOpportunityIdentity(candidate)
      && highTimedUnresolvedEventTypes.has(candidate.eventType)
      && candidate.temporalConfidence !== 'high'))
    candidates.splice(0, candidates.length, ...retained)
  }

  candidates.splice(0, candidates.length, ...coalesceGmailEventDescriptions(candidates, boundedPieces))
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
    businessAmbiguities.push('Supplementary location/link details could not be uniquely assigned across multiple events.')
  }
  return {
    receivedAt: legacy.receivedAt,
    pendingInterviewReschedule,
    recruitingRelevant: !excluded && legacy.classification === 'recruiting',
    gaps: !excluded && (legacy.classification === 'recruiting' || candidates.length) ? [...new Set([...interpretationGaps, ...businessAmbiguities])] : [],
    issueKinds: !excluded && (legacy.classification === 'recruiting' || candidates.length) ? [
      ...(interpretationGaps.length ? ['interpretation_failure' as const] : []),
      ...(businessAmbiguities.length ? ['business_ambiguity' as const] : []),
    ] : [],
    capabilityBoundaries: !excluded && (legacy.classification === 'recruiting' || candidates.length) ? [...new Set(capabilityBoundaries)] : [],
    observation: {
      contractVersion: 1, inputId: `gmail:${message.id}:uu06-v1`,
      source: { kind: 'gmail', sourceId: GMAIL_SOURCE_ID, sourceRecordId: message.id!,
        sourceVersion: 'uu06-v1', observedAt: now.toISOString(), assertedAt: boundedRescheduleSource ? boundedSourceTime : legacy.receivedAt, timezone: 'Asia/Shanghai' },
      originalTextFingerprint: `fnv1a:${stableIngestionHash(sourceText)}`,
      statementMode: nonAssertion ? 'quote' : 'assertion', candidates,
    },
  }
}

export async function runGmailAutomationForBinding(options: {
  binding: GmailAutomationBinding
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  refreshLifecycle?: GoogleRefreshLifecycle
  fetchImpl?: typeof fetch
  now?: () => Date
  execution?: { observer?: GmailExecutionObserver; beforeWorkspaceWrite: () => Promise<void> }
}): Promise<GmailAutomationRunResult> {
  if (options.binding.gmailIntakeConsentVersion !== 'uu06-v1') return runLegacyGmailAutomationForBinding(options)
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now?.() ?? new Date()
  const checkedAt = now.toISOString()
  if (!options.binding.grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
    throw new WorkspaceSourceError('GOOGLE_GMAIL_SCOPE_MISSING', 'Gmail automation requires the Gmail read-only permission. Reconnect Google and enable recruiting-email tracking.', false)
  }

  options.execution?.observer?.phase('token_refresh')
  const refreshToken = await decryptSecret(options.binding.refreshTokenCiphertext, options.tokenEncryptionKey)
  const accessToken = await refreshGoogleAccessToken(refreshToken, {
    ...options.refreshLifecycle,
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
        reuseReadPreimage: true,
        timezone: 'Asia/Shanghai',
        fetchImpl,
      })
    : createDriveWorkspaceSource({
        getAccessToken: () => accessToken,
        fetchImpl,
        timezone: 'Asia/Shanghai',
      })
  options.execution?.observer?.phase('workspace_read')
  const workspace = await source.read()
  const backfillComplete = (workspace.snapshot.data.timeline ?? []).some((item) =>
    item.ingestion?.sourceKind === 'gmail' && item.ingestion.sourceId === GMAIL_SOURCE_ID
    && item.ingestion.sourceRecordId === 'coverage-boundary:uu06-90-days')
  options.execution?.observer?.phase('gmail_list')
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
  options.execution?.observer?.phase('message_parse')
  const records = batch.messages
    .map((message) => { const record = gmailSemanticRecordFromMessage(message, workspace.snapshot.data.opportunities, now); options.execution?.observer?.processed(); return record })
    .filter((record): record is GmailSemanticRecord => Boolean(record))
  for (const sourceRecordId of batch.unavailableMessageIds) {
    records.push({
      receivedAt: checkedAt,
      gaps: ['Gmail reported this source record, but its message payload was no longer retrievable when PJSDAS fetched it; no recruiting facts were inferred.'],
      issueKinds: ['transport_gap'],
      observation: {
        contractVersion: 1,
        inputId: `gmail:${sourceRecordId}:payload-unavailable-v1`,
        source: {
          kind: 'gmail',
          sourceId: GMAIL_SOURCE_ID,
          sourceRecordId,
          sourceVersion: 'payload-unavailable-v1',
          observedAt: checkedAt,
          timezone: workspace.context.timezone ?? 'Asia/Shanghai',
        },
        statementMode: 'assertion',
        candidates: [],
      },
    })
  }
  if (!backfillComplete && batch.usedFallbackScan && batch.coverageComplete) {
    records.unshift({
      receivedAt: checkedAt,
      gaps: [],
      capabilityBoundaries: ['Gmail initial backfill covers the previous 90 days, including archived mail; older mail and spam/trash are outside this bounded coverage. Push delivery is not configured; periodic history polling remains active.'],
      observation: { contractVersion: 1, inputId: 'gmail:coverage-boundary:uu06-90-days',
        source: { kind: 'gmail', sourceId: GMAIL_SOURCE_ID, sourceRecordId: 'coverage-boundary:uu06-90-days', observedAt: checkedAt, timezone: 'Asia/Shanghai' },
        statementMode: 'assertion', candidates: [] },
    })
  }
  if (batch.recoveryGapReason) {
    records.unshift({
      receivedAt: checkedAt, gaps: [batch.recoveryGapReason], issueKinds: ['transport_gap'],
      observation: {
        contractVersion: 1, inputId: `gmail:coverage-gap:${stableCoverageGapId(options.binding.gmailHistoryId ?? 'initial', checkedAt)}`,
        source: { kind: 'gmail', sourceId: GMAIL_SOURCE_ID,
          sourceRecordId: `coverage-gap:${stableCoverageGapId(options.binding.gmailHistoryId ?? 'initial', checkedAt)}`,
          observedAt: checkedAt, timezone: workspace.context.timezone ?? 'Asia/Shanghai' },
        statementMode: 'assertion', candidates: [],
      },
    })
  }
  options.execution?.observer?.phase('semantic_apply')
  const result = applyGmailSemanticBatch(workspace.snapshot, {
    runId: `gmail:auto:${checkedAt}`, sourceId: GMAIL_SOURCE_ID, checkedAt,
    cursor: batch.coverageComplete ? batch.nextHistoryId : undefined, records,
    authorized: true, workspaceRevision: workspace.context.workspaceVersion,
  })

  let workspaceVersion = workspace.context.workspaceVersion
  if (!result.alreadyApplied) {
    await options.execution?.beforeWorkspaceWrite()
    options.execution?.observer?.phase('workspace_commit')
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

  options.execution?.observer?.phase('checkpoint')
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
  refreshLifecycle?: GoogleRefreshLifecycle
  fetchImpl?: typeof fetch
  now?: () => Date
  execution?: { observer?: GmailExecutionObserver; beforeWorkspaceWrite: () => Promise<void> }
}): Promise<GmailAutomationRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now?.() ?? new Date()
  const checkedAt = now.toISOString()
  if (!options.binding.grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
    throw new WorkspaceSourceError('GOOGLE_GMAIL_SCOPE_MISSING', 'Gmail automation requires the Gmail read-only permission. Reconnect Google and enable recruiting-email tracking.', false)
  }

  options.execution?.observer?.phase('token_refresh')
  const refreshToken = await decryptSecret(options.binding.refreshTokenCiphertext, options.tokenEncryptionKey)
  const accessToken = await refreshGoogleAccessToken(refreshToken, {
    ...options.refreshLifecycle,
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
        reuseReadPreimage: true,
        timezone: 'Asia/Shanghai',
        fetchImpl,
      })
    : createDriveWorkspaceSource({
        getAccessToken: () => accessToken,
        fetchImpl,
        timezone: 'Asia/Shanghai',
      })
  options.execution?.observer?.phase('workspace_read')
  const workspace = await source.read()
  options.execution?.observer?.phase('gmail_list')
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
  options.execution?.observer?.phase('message_parse')
  const messages = batch.messages
    .map((message) => { const record = gmailObservationFromMessage(message, workspace.snapshot.data.opportunities, now); options.execution?.observer?.processed(); return record })
    .filter((message): message is HardenedGmailMessageObservation => Boolean(message))
  for (const sourceRecordId of batch.unavailableMessageIds) {
    messages.push({
      sourceRecordId,
      receivedAt: checkedAt,
      classification: 'recruiting',
      confidence: 'low',
      subject: 'PJSDAS Gmail source record unavailable',
      notes: 'Gmail reported this source record, but its message payload was no longer retrievable when PJSDAS fetched it; no recruiting facts were inferred.',
    })
  }
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
  options.execution?.observer?.phase('semantic_apply')
  const result = applyGmailIngestionHardened(workspace.snapshot, {
    runId: `gmail:auto:${checkedAt}`,
    sourceId: GMAIL_SOURCE_ID,
    producer: 'server_scheduler',
    startedAt: checkedAt,
    completedAt: checkedAt,
    cursor: batch.coverageComplete ? batch.nextHistoryId : undefined,
    sourcePolicy: bootstrapPolicyFor('gmail', GMAIL_SOURCE_ID),
    messages,
  })

  let workspaceVersion = workspace.context.workspaceVersion
  if (!result.alreadyApplied) {
    await options.execution?.beforeWorkspaceWrite()
    options.execution?.observer?.phase('workspace_commit')
    const writable = requireWritableWorkspaceSource(source)
    const written = await writable.write({
      snapshot: result.snapshot,
      expectedWorkspaceVersion: workspace.context.workspaceVersion,
      updatedByDevice: 'gmail-automation-worker',
    })
    workspaceVersion = written.context.workspaceVersion
  }

  options.execution?.observer?.phase('checkpoint')
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

function executionMetrics(binding: GmailAutomationBinding, batch: GmailAutomationFetchResult,
  timeline: import('../src/model.js').TimelineRecord[], committedAt: number, accounted: number, unresolved: number): GmailExecutionMetrics {
  const mode = batch.usedFallbackScan ? binding.gmailHistoryId ? 'history_recovery' : 'initial_backfill' : 'history'
  const receivedTimes = mode === 'history' ? batch.messages.filter((message) => message.id
    && !alreadyIngested(timeline, { sourceKind: 'gmail', sourceId: GMAIL_SOURCE_ID, sourceRecordId: message.id }))
    .map((message) => message.internalDate ? Number(message.internalDate) : Date.parse(header(message.payload, 'date'))) : []
  const receivedCount = batch.messages.length + batch.unavailableMessageIds.length
  return { status: 'completed', mode, receivedCount,
    accountedCount: Math.min(accounted, receivedCount), unresolvedCount: Math.min(unresolved, receivedCount),
    recordGapCount: batch.unavailableMessageIds.length,
    ...(mode === 'history' ? { historyLag: aggregateHistoryLag(receivedTimes, committedAt) } : {}) }
}
