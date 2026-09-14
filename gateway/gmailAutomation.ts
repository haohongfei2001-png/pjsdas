import { parseRecruitingNotification } from '../src/notificationParser.js'
import { stageForProcessEvent } from '../src/processEvents.js'
import {
  applyGmailIngestionHardened,
  type HardenedGmailMessageObservation,
} from '../src/ingestionHardening.js'
import { bootstrapPolicyFor } from '../src/sourceRegistry.js'
import type { Opportunity, ProcessEventType } from '../src/model.js'
import { createDriveWorkspaceSource } from './driveWorkspaceSource.js'
import { refreshGoogleAccessToken } from './googleOAuthTokens.js'
import { decryptSecret } from './tokenCrypto.js'
import { GMAIL_READONLY_SCOPE, type GmailAutomationBinding } from './automationConnectionStore.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GMAIL_SOURCE_ID = 'gmail:primary'
const MAX_MESSAGES_PER_RUN = 100
const INITIAL_LOOKBACK_DAYS = 7

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
  payload?: GmailPart
}

interface GmailProfile { historyId?: string }
interface GmailMessageList { messages?: Array<{ id?: string }>; nextPageToken?: string }
interface GmailHistoryList {
  historyId?: string
  nextPageToken?: string
  history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>
}

export interface GmailAutomationFetchResult {
  messages: GmailMessage[]
  nextHistoryId: string
  usedFallbackScan: boolean
}

export interface GmailAutomationRunResult {
  userId: string
  checkedAt: string
  nextHistoryId: string
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
  return cleanText((plain.length ? plain : html).join('\n')).slice(0, 12_000)
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
  if (response.status === 403) throw new WorkspaceSourceError('GOOGLE_GMAIL_FORBIDDEN', 'Google denied Gmail read access for PJSDAS.', false)
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

async function initialMessageIds(fetchImpl: typeof fetch, accessToken: string) {
  const ids: string[] = []
  let pageToken: string | undefined
  while (ids.length < MAX_MESSAGES_PER_RUN) {
    const params = new URLSearchParams({
      maxResults: String(Math.min(100, MAX_MESSAGES_PER_RUN - ids.length)),
      q: `newer_than:${INITIAL_LOOKBACK_DAYS}d -in:spam -in:trash`,
      labelIds: 'INBOX',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const payload = await gmailJson<GmailMessageList>(fetchImpl, accessToken, `/messages?${params.toString()}`)
    for (const item of payload.messages ?? []) if (item.id) ids.push(item.id)
    pageToken = payload.nextPageToken
    if (!pageToken) break
  }
  return [...new Set(ids)].slice(0, MAX_MESSAGES_PER_RUN)
}

async function historyMessageIds(fetchImpl: typeof fetch, accessToken: string, startHistoryId: string) {
  const ids: string[] = []
  let pageToken: string | undefined
  let latestHistoryId: string | undefined
  while (ids.length < MAX_MESSAGES_PER_RUN) {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
      labelId: 'INBOX',
      maxResults: '100',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const response = await gmailFetch(fetchImpl, accessToken, `/history?${params.toString()}`)
    if (response.status === 404) return { expired: true as const, ids: [], historyId: undefined }
    if (!response.ok) throw new WorkspaceSourceError('GMAIL_REQUEST_FAILED', `Gmail history request failed (HTTP ${response.status}).`, false)
    const payload = await response.json().catch(() => undefined) as GmailHistoryList | undefined
    if (!payload) throw new WorkspaceSourceError('GMAIL_RESPONSE_INVALID', 'Gmail history response was invalid.', true)
    latestHistoryId = payload.historyId ?? latestHistoryId
    for (const history of payload.history ?? []) {
      for (const added of history.messagesAdded ?? []) if (added.message?.id) ids.push(added.message.id)
    }
    pageToken = payload.nextPageToken
    if (!pageToken || ids.length >= MAX_MESSAGES_PER_RUN) break
  }
  return { expired: false as const, ids: [...new Set(ids)].slice(0, MAX_MESSAGES_PER_RUN), historyId: latestHistoryId }
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
  fetchImpl?: typeof fetch
}): Promise<GmailAutomationFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const currentHistoryId = await gmailProfile(fetchImpl, options.accessToken)
  let ids: string[]
  let usedFallbackScan = false
  let nextHistoryId = currentHistoryId

  if (options.startHistoryId) {
    const history = await historyMessageIds(fetchImpl, options.accessToken, options.startHistoryId)
    if (history.expired) {
      usedFallbackScan = true
      ids = await initialMessageIds(fetchImpl, options.accessToken)
    } else {
      ids = history.ids
      nextHistoryId = history.historyId ?? currentHistoryId
    }
  } else {
    usedFallbackScan = true
    ids = await initialMessageIds(fetchImpl, options.accessToken)
  }

  return { messages: await fetchMessages(fetchImpl, options.accessToken, ids), nextHistoryId, usedFallbackScan }
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

export async function runGmailAutomationForBinding(options: {
  binding: GmailAutomationBinding
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  fetchImpl?: typeof fetch
  now?: () => Date
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
  const source = createDriveWorkspaceSource({
    getAccessToken: () => accessToken,
    fetchImpl,
    timezone: 'Asia/Shanghai',
  })
  const workspace = await source.read()
  const batch = await fetchGmailAutomationBatch({
    accessToken,
    startHistoryId: options.binding.gmailHistoryId,
    fetchImpl,
  })
  const messages = batch.messages
    .map((message) => gmailObservationFromMessage(message, workspace.snapshot.data.opportunities, now))
    .filter((message): message is HardenedGmailMessageObservation => Boolean(message))
  const result = applyGmailIngestionHardened(workspace.snapshot, {
    runId: `gmail:auto:${checkedAt}`,
    sourceId: GMAIL_SOURCE_ID,
    startedAt: checkedAt,
    completedAt: checkedAt,
    cursor: batch.nextHistoryId,
    sourcePolicy: bootstrapPolicyFor('gmail', GMAIL_SOURCE_ID),
    messages,
  })

  let workspaceVersion = workspace.context.workspaceVersion
  if (!result.alreadyApplied) {
    const written = await source.write({
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
    receivedCount: result.run.receivedCount,
    accountedCount: result.run.accountedCount,
    unresolvedCount: result.run.outcomes.unresolved ?? 0,
    alreadyApplied: result.alreadyApplied,
    workspaceVersion,
    usedFallbackScan: batch.usedFallbackScan,
  }
}
