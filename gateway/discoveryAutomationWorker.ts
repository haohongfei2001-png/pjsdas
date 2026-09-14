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
import {
  effectiveSourceRegistry,
  type IngestionSourcePolicy,
} from '../src/sourceRegistry.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
import { createDriveWorkspaceSource } from './driveWorkspaceSource.js'
import { refreshGoogleAccessToken } from './googleOAuthTokens.js'
import { decryptSecret } from './tokenCrypto.js'
import type { DiscoveryAutomationBinding } from './automationConnectionStore.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

const DEFAULT_MODEL = 'perplexity/sonar'
const MAX_EXISTING_IDENTITIES = 100
const MAX_RECENT_REJECTIONS = 40

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

function gatewayErrorDetails(caught: unknown) {
  if (!caught || typeof caught !== 'object') return { type: undefined, message: undefined }
  const candidate = caught as { responseBody?: unknown; data?: unknown }
  let payload: unknown = candidate.data
  if (typeof candidate.responseBody === 'string') {
    try {
      payload = JSON.parse(candidate.responseBody) as unknown
    } catch {
      // Non-JSON provider bodies are intentionally not surfaced.
    }
  }
  if (!payload || typeof payload !== 'object') return { type: undefined, message: undefined }
  const root = payload as Record<string, unknown>
  const nested = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root
  return {
    type: typeof nested.type === 'string' ? nested.type : undefined,
    message: typeof nested.message === 'string'
      ? nested.message
      : typeof root.error === 'string'
        ? root.error
        : undefined,
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
}) {
  const content = await aiGatewayText(buildPrompt(snapshot, sourceRun, input.executionRules, input.incrementalSince, input.now), input.ai)
  const parsed = discoveryResponseSchema.safeParse(parseJsonObject(content))
  if (!parsed.success) {
    throw new WorkspaceSourceError('DISCOVERY_MODEL_INVALID', parsed.error.issues[0]?.message ?? 'Discovery model output violated the PJSDAS schema.', true)
  }
  if (parsed.data.observations.length > sourceRun.maxObservations) {
    throw new WorkspaceSourceError('DISCOVERY_MODEL_INVALID', `Discovery model returned more than ${sourceRun.maxObservations} observations.`, true)
  }
  return parsed.data.observations
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
