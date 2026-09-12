import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import {
  assertChangeSetValid,
  createActionStatusChangeSet,
  createProgressChangeSet,
  createRulesChangeSet,
  type ChangeSetOperation,
  type ChangeSetRecord,
} from '../src/changeSet.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import {
  decisionRulesForSnapshot,
  resolvedFitComponentWeights,
  resolvedOpportunityValueComponentWeights,
  validateDecisionRules,
  type DecisionRules,
  type DecisionWeights,
  type FitComponentWeights,
  type OpportunityValueComponentWeights,
} from '../src/decisionRules.js'
import { discoveryProfileForSnapshot, isDiscoveryProfileConfigured } from '../src/discoveryProfile.js'
import { screenDiscoveryCandidates } from '../src/discoveryQuality.js'
import { createJobPostingEvidence } from '../src/jobPosting.js'
import {
  assessmentWarnings,
  createOpportunityAssessment,
  scoreOpportunityAssessment,
  validateOpportunityAssessment,
} from '../src/opportunityAssessment.js'
import { createOpportunityFacts, validateOpportunityFacts } from '../src/richOpportunity.js'
import { buildMcpProposalReviewUrl, type McpDiscoveryReview } from '../src/ai/mcpProposal.js'
import { parseProgressUpdate } from '../src/progressUpdate.js'
import type {
  ActionStatus,
  DiscoveryConfidence,
  Opportunity,
  OpportunityAssessment,
  OpportunityRole,
} from '../src/model.js'
import { createSignedProposalToken } from './proposalToken.js'
import { WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

const weightPatchSchema = z.object({
  opportunity: z.number().min(0).max(100).optional(),
  fit: z.number().min(0).max(100).optional(),
  urgency: z.number().min(0).max(100).optional(),
  stage: z.number().min(0).max(100).optional(),
  leverage: z.number().min(0).max(100).optional(),
  delayCost: z.number().min(0).max(100).optional(),
  timeEfficiency: z.number().min(0).max(100).optional(),
}).strict()

const fitComponentWeightPatchSchema = z.object({
  roleDirection: z.number().min(0).max(100).optional(),
  skills: z.number().min(0).max(100).optional(),
  education: z.number().min(0).max(100).optional(),
  experience: z.number().min(0).max(100).optional(),
  industry: z.number().min(0).max(100).optional(),
  language: z.number().min(0).max(100).optional(),
  location: z.number().min(0).max(100).optional(),
}).strict()

const opportunityValueComponentWeightPatchSchema = z.object({
  companyQuality: z.number().min(0).max(100).optional(),
  roleGrowth: z.number().min(0).max(100).optional(),
  compensation: z.number().min(0).max(100).optional(),
  careerOptionality: z.number().min(0).max(100).optional(),
  brandValue: z.number().min(0).max(100).optional(),
  industryGrowth: z.number().min(0).max(100).optional(),
  locationValue: z.number().min(0).max(100).optional(),
}).strict()

const rulesPatchSchema = z.object({
  hardDeadlineHorizonHours: z.number().int().min(1).max(336).optional(),
  fixedEventHorizonHours: z.number().int().min(1).max(336).optional(),
  nearDeadlineStretchMinutes: z.number().int().min(0).max(180).optional(),
  followUpDailyCap: z.number().int().min(0).max(10).optional(),
  prepDailyCap: z.number().int().min(0).max(10).optional(),
  upcomingHorizonDays: z.number().int().min(1).max(30).optional(),
  upcomingNodeLimit: z.number().int().min(1).max(50).optional(),
  riskCriticalHours: z.number().int().min(1).max(168).optional(),
  riskHighHours: z.number().int().min(1).max(336).optional(),
  riskNearHours: z.number().int().min(1).max(504).optional(),
  riskWatchHours: z.number().int().min(1).max(720).optional(),
  weights: weightPatchSchema.optional(),
  fitComponentWeights: fitComponentWeightPatchSchema.optional(),
  opportunityValueComponentWeights: opportunityValueComponentWeightPatchSchema.optional(),
}).strict()

const actionStatusChangeSchema = z.object({
  actionId: z.string().trim().min(1),
  status: z.enum(['todo', 'doing', 'done', 'skipped']),
}).strict()

const discoveryConfidenceSchema = z.enum(['high', 'medium', 'low'])
const opportunityRoleSchema = z.enum(['core', 'backup', 'reach', 'lottery', 'practice'])
const postingStatusSchema = z.enum(['open', 'closed', 'unknown'])

function validDateString(value: string) {
  return !Number.isNaN(new Date(value).getTime())
}

function publicHttpUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    const host = url.hostname.toLocaleLowerCase()
    return Boolean(host && host !== 'localhost' && host !== '0.0.0.0' && host !== '::1' && !host.startsWith('127.'))
  } catch {
    return false
  }
}

const richFactsSchema = z.object({
  department: z.string().trim().min(1).max(200).optional(),
  businessUnit: z.string().trim().min(1).max(200).optional(),
  locations: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  recruitmentBatch: z.string().trim().min(1).max(160).optional(),
  responsibilities: z.array(z.string().trim().min(1).max(320)).max(12).optional(),
  requirements: z.array(z.string().trim().min(1).max(320)).max(16).optional(),
  educationRequirement: z.string().trim().min(1).max(300).optional(),
  majorRequirements: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  experienceRequirement: z.string().trim().min(1).max(300).optional(),
  skills: z.array(z.string().trim().min(1).max(160)).max(16).optional(),
  languageRequirements: z.array(z.string().trim().min(1).max(180)).max(8).optional(),
  applicationMethod: z.string().trim().min(1).max(300).optional(),
  applicationUrl: z.string().trim().min(1).max(2_000).refine(publicHttpUrl, 'applicationUrl must be a public http(s) URL.').optional(),
  annualCompensationMaxWan: z.number().min(0).max(1000).optional(),
  compensationBasis: z.string().trim().min(1).max(300).optional(),
  evidenceSummary: z.string().trim().min(1).max(1_200).optional(),
}).strict()

const assessmentComponentSchema = z.object({
  score: z.number().min(0).max(100),
  confidence: discoveryConfidenceSchema,
  rationale: z.string().trim().min(1).max(500),
}).strict()

const fitAssessmentSchema = z.object({
  roleDirection: assessmentComponentSchema.optional(),
  skills: assessmentComponentSchema.optional(),
  education: assessmentComponentSchema.optional(),
  experience: assessmentComponentSchema.optional(),
  industry: assessmentComponentSchema.optional(),
  language: assessmentComponentSchema.optional(),
  location: assessmentComponentSchema.optional(),
}).strict().refine((value) => Object.values(value).some(Boolean), 'assessment.fit must include at least one component.')

const opportunityValueAssessmentSchema = z.object({
  companyQuality: assessmentComponentSchema.optional(),
  roleGrowth: assessmentComponentSchema.optional(),
  compensation: assessmentComponentSchema.optional(),
  careerOptionality: assessmentComponentSchema.optional(),
  brandValue: assessmentComponentSchema.optional(),
  industryGrowth: assessmentComponentSchema.optional(),
  locationValue: assessmentComponentSchema.optional(),
}).strict().refine((value) => Object.values(value).some(Boolean), 'assessment.opportunityValue must include at least one component.')

const componentAssessmentSchema = z.object({
  fit: fitAssessmentSchema,
  opportunityValue: opportunityValueAssessmentSchema,
}).strict()

const discoveredOpportunitySchema = z.object({
  company: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(240),
  sourceUrl: z.string().trim().min(1).max(2_000).refine(publicHttpUrl, 'sourceUrl must be a public http(s) URL.'),
  sourceTitle: z.string().trim().min(1).max(300),
  sourceEvidenceText: z.string().trim().min(1).max(2_000).optional(),
  postingStatus: postingStatusSchema.optional(),
  location: z.string().trim().min(1).max(240).optional(),
  deadline: z.string().trim().refine(validDateString, 'deadline must be a valid date/time.').optional(),
  compensationText: z.string().trim().min(1).max(500).optional(),
  annualCompensationMinWan: z.number().min(0).max(1000).optional(),
  facts: richFactsSchema.optional(),
  assessment: componentAssessmentSchema.optional(),
  rationale: z.string().trim().min(1).max(1_600),
  roleType: opportunityRoleSchema,
  opportunityValue: z.number().min(0).max(100).optional(),
  fitScore: z.number().min(0).max(100).optional(),
  fitConfidence: discoveryConfidenceSchema.optional(),
  opportunityValueConfidence: discoveryConfidenceSchema.optional(),
  discoveredAt: z.string().trim().refine(validDateString, 'discoveredAt must be a valid date/time.').optional(),
}).strict().superRefine((value, ctx) => {
  const legacyComplete = value.opportunityValue !== undefined && value.fitScore !== undefined && value.fitConfidence !== undefined && value.opportunityValueConfidence !== undefined
  if (!value.assessment && !legacyComplete) {
    ctx.addIssue({ code: 'custom', message: 'Provide component assessment, or all legacy score/confidence fields.' })
  }
})

export const proposeChangesSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  progressText: z.string().trim().min(1).max(4000).optional(),
  actionStatusChanges: z.array(actionStatusChangeSchema).max(20).optional(),
  decisionRulesPatch: rulesPatchSchema.optional(),
  discoveredOpportunities: z.array(discoveredOpportunitySchema).min(1).max(20).optional(),
}).refine(
  (value) => Boolean(
    value.progressText ||
    value.actionStatusChanges?.length ||
    value.decisionRulesPatch ||
    value.discoveredOpportunities?.length,
  ),
  { message: 'At least one proposed change is required.' },
).refine(
  (value) => !value.discoveredOpportunities?.length || !(
    value.progressText || value.actionStatusChanges?.length || value.decisionRulesPatch
  ),
  { message: 'Discovered opportunities must be reviewed in their own ChangeSet instead of being mixed with other changes.' },
)

export type ProposeChangesInput = z.infer<typeof proposeChangesSchema>

type ParsedDiscoveryCandidate = z.infer<typeof discoveredOpportunitySchema>
type NormalizedDiscoveryCandidate = ParsedDiscoveryCandidate & {
  opportunityValue: number
  fitScore: number
  fitConfidence: DiscoveryConfidence
  opportunityValueConfidence: DiscoveryConfidence
  assessment?: OpportunityAssessment
  assessmentWarnings?: string[]
}

export interface ProposeChangesOptions {
  signingKey: string
}

function proposalId(now: Date) {
  const compact = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0')
  return `CS-MCP-${compact}-${suffix}`
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function compactIdentity(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}

function opportunityIdentity(company: string, role: string) {
  return `${compactIdentity(company)}|${compactIdentity(role)}`
}

function discoveredOpportunityId(company: string, role: string) {
  return `discovery:${stableHash(opportunityIdentity(company, role))}`
}

function failure(code: string, message: string, retryable = false): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message, retryable }, null, 2) }],
  }
}

function success(output: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
  }
}

function applyRulesPatch(current: DecisionRules, patch: NonNullable<ProposeChangesInput['decisionRulesPatch']>) {
  const weights: DecisionWeights = {
    ...current.weights,
    ...(patch.weights ?? {}),
  }
  const fitComponentWeights: FitComponentWeights = {
    ...resolvedFitComponentWeights(current),
    ...(patch.fitComponentWeights ?? {}),
  }
  const opportunityValueComponentWeights: OpportunityValueComponentWeights = {
    ...resolvedOpportunityValueComponentWeights(current),
    ...(patch.opportunityValueComponentWeights ?? {}),
  }
  const next: DecisionRules = {
    ...current,
    ...patch,
    weights,
    fitComponentWeights,
    opportunityValueComponentWeights,
  }
  const errors = validateDecisionRules(next)
  if (errors.length) {
    throw new WorkspaceSourceError('INVALID_ARGUMENT', `Decision Rules proposal is invalid: ${errors[0]}`, false)
  }
  return next
}

function normalizeDiscoveryCandidate(candidate: ParsedDiscoveryCandidate, rules: DecisionRules, now: Date): NormalizedDiscoveryCandidate {
  if (!candidate.assessment) {
    const { assessment: _assessment, ...legacyCandidate } = candidate
    return {
      ...legacyCandidate,
      assessment: undefined,
      opportunityValue: candidate.opportunityValue!,
      fitScore: candidate.fitScore!,
      fitConfidence: candidate.fitConfidence!,
      opportunityValueConfidence: candidate.opportunityValueConfidence!,
    }
  }
  const assessedAt = candidate.discoveredAt ?? now.toISOString()
  const assessment = createOpportunityAssessment(candidate.assessment, assessedAt)
  const errors = validateOpportunityAssessment(assessment)
  if (errors.length) throw new WorkspaceSourceError('INVALID_ARGUMENT', `Opportunity component assessment is invalid: ${errors[0]}`, false)
  const scored = scoreOpportunityAssessment(assessment, rules)
  return {
    ...candidate,
    assessment,
    fitScore: scored.fit.score,
    opportunityValue: scored.opportunityValue.score,
    fitConfidence: scored.fit.confidence,
    opportunityValueConfidence: scored.opportunityValue.confidence,
    assessmentWarnings: assessmentWarnings(assessment, rules),
  }
}

function uniqueOperations(operations: ChangeSetOperation[]) {
  const byId = new Map<string, ChangeSetOperation>()
  for (const operation of operations) byId.set(operation.id, operation)
  return [...byId.values()]
}

function makeMcpChangeSet(
  title: string,
  operations: ChangeSetOperation[],
  expectedWorkspaceVersion: string | undefined,
  expectedWorkspaceFingerprint: string,
  now: Date,
): ChangeSetRecord {
  const timestamp = now.toISOString()
  const changeSet: ChangeSetRecord = {
    id: proposalId(now),
    version: 1,
    source: 'mcp',
    status: 'pending',
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    expectedWorkspaceVersion,
    expectedWorkspaceFingerprint,
    operations,
  }
  assertChangeSetValid(changeSet)
  return changeSet
}

function discoveredOpportunity(
  candidate: NormalizedDiscoveryCandidate,
  warnings: string[],
  now: Date,
): Opportunity {
  const discoveredAt = candidate.discoveredAt ?? now.toISOString()
  const posting = createJobPostingEvidence({
    company: candidate.company,
    role: candidate.role,
    sourceUrl: candidate.sourceUrl,
    sourceTitle: candidate.sourceTitle,
    location: candidate.location,
    deadline: candidate.deadline,
    compensationText: candidate.compensationText,
    postingStatus: candidate.postingStatus ?? 'unknown',
    observedAt: discoveredAt,
  })
  const facts = createOpportunityFacts({
    sourceUrl: candidate.sourceUrl,
    sourceTitle: candidate.sourceTitle,
    verifiedAt: discoveredAt,
    location: candidate.location,
    deadline: candidate.deadline,
    compensationText: candidate.compensationText,
    annualCompensationMinWan: candidate.annualCompensationMinWan,
    facts: candidate.facts,
  })
  const factErrors = validateOpportunityFacts(facts)
  if (factErrors.length) {
    throw new WorkspaceSourceError('INVALID_ARGUMENT', `Rich Opportunity facts are invalid: ${factErrors[0]}`, false)
  }
  return {
    id: discoveredOpportunityId(candidate.company, candidate.role),
    company: candidate.company,
    role: candidate.role,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: candidate.roleType as OpportunityRole,
    early: false,
    deadline: candidate.deadline,
    sourcePriority: 'AI 岗位发现',
    salaryReference: candidate.compensationText,
    nextActionLabel: '审阅并投递',
    prepEstimateMinutes: 45,
    opportunityValue: candidate.opportunityValue,
    fitScore: candidate.fitScore,
    locallyManaged: true,
    importedAt: discoveredAt,
    detail: {
      salaryMinWan: candidate.annualCompensationMinWan,
      salaryMaxWan: candidate.facts?.annualCompensationMaxWan,
      salaryBasis: candidate.facts?.compensationBasis,
      salaryRaw: candidate.compensationText,
      facts,
      assessment: candidate.assessment,
      discovery: {
        sourceUrl: candidate.sourceUrl,
        sourceTitle: candidate.sourceTitle,
        location: candidate.location,
        compensationText: candidate.compensationText,
        rationale: candidate.rationale,
        discoveredAt,
        fitConfidence: candidate.fitConfidence,
        opportunityValueConfidence: candidate.opportunityValueConfidence,
        profileWarnings: warnings.length ? warnings : undefined,
        posting,
      },
    },
  }
}

function discoveryReviewMetadata(
  screening: NonNullable<ReturnType<typeof screenDiscoveryCandidates>>,
): McpDiscoveryReview {
  return {
    received: screening.received,
    accepted: screening.accepted.length,
    duplicateCount: screening.skippedDuplicates.length,
    rejectedCount: screening.rejectedCandidates.length,
    deferredCount: screening.deferredCandidates.length,
    skippedDuplicates: screening.skippedDuplicates.map((item) => ({ ...item })),
    rejectedCandidates: screening.rejectedCandidates.map((item) => ({ ...item, reasons: [...item.reasons] })),
    deferredCandidates: screening.deferredCandidates.map((item) => ({ ...item })),
  }
}

export async function invokeProposeChanges(
  source: WorkspaceSource,
  rawInput: unknown,
  options: ProposeChangesOptions,
): Promise<CallToolResult> {
  try {
    const input = proposeChangesSchema.parse(rawInput)
    const { snapshot, context } = await source.read()
    const now = context.now ? new Date(context.now) : new Date()
    const operations: ChangeSetOperation[] = []
    let discoveryScreening: ReturnType<typeof screenDiscoveryCandidates<NormalizedDiscoveryCandidate>> | undefined

    if (input.discoveredOpportunities?.length) {
      const profile = discoveryProfileForSnapshot(snapshot.data.discoveryProfile)
      if (!isDiscoveryProfileConfigured(profile)) {
        throw new WorkspaceSourceError(
          'DISCOVERY_PROFILE_REQUIRED',
          'PJSDAS Discovery Profile is empty. Ask the user to configure explicit durable job-discovery preferences in PJSDAS before proposing web-discovered jobs.',
          false,
        )
      }
      const rules = decisionRulesForSnapshot(snapshot.data.decisionRules)
      const normalizedCandidates = input.discoveredOpportunities.map((candidate) => normalizeDiscoveryCandidate(candidate, rules, now))
      const screened = screenDiscoveryCandidates(
        profile,
        normalizedCandidates,
        snapshot.data.opportunities,
        rules.weights,
        now,
        snapshot.data.timeline ?? [],
        snapshot.data.discoveryInbox ?? [],
      )
      discoveryScreening = screened
      for (const item of screened.accepted) {
        const warnings = [...(item.candidate.assessmentWarnings ?? []), ...item.warnings].slice(0, 10)
        const opportunity = discoveredOpportunity(item.candidate, warnings, now)
        operations.push({
          id: `discovery:add:${opportunity.id}`,
          kind: 'add_discovered_opportunity',
          summary: `新增发现岗位｜${opportunity.company}｜${opportunity.role}`,
          opportunity,
        })
      }
    }

    if (input.progressText) {
      const parsed = parseProgressUpdate(input.progressText, snapshot.data.opportunities, now)
      if (parsed.unresolved.length > 0) {
        const reasons = parsed.unresolved.slice(0, 3).map((item) => item.reason).join('；')
        throw new WorkspaceSourceError(
          'PROPOSAL_NEEDS_CLARIFICATION',
          `PJSDAS could not safely normalize every requested update. Ask the user to clarify before proposing changes. ${reasons}`,
          false,
        )
      }
      if (parsed.executable.length > 0) {
        operations.push(...createProgressChangeSet(parsed.executable, now).operations)
      }
    }

    for (const requested of input.actionStatusChanges ?? []) {
      const action = snapshot.data.actions.find((item) => item.id === requested.actionId)
      if (!action) {
        throw new WorkspaceSourceError(
          'NOT_FOUND',
          `Action ${requested.actionId} does not exist in the current PJSDAS workspace. Read the current plan or pipeline again before proposing this change.`,
          false,
        )
      }
      const proposed = createActionStatusChangeSet(action, requested.status as ActionStatus, now)
      if (proposed) operations.push(...proposed.operations)
    }

    if (input.decisionRulesPatch) {
      const current = decisionRulesForSnapshot(snapshot.data.decisionRules)
      const next = applyRulesPatch(current, input.decisionRulesPatch)
      const proposed = createRulesChangeSet(current, next, 'save', now)
      if (proposed) operations.push(...proposed.operations)
    }

    const normalized = uniqueOperations(operations)
    if (normalized.length === 0) {
      if (discoveryScreening) {
        const onlyDuplicates = discoveryScreening.skippedDuplicates.length > 0 && discoveryScreening.rejectedCandidates.length === 0
        const detail = [
          ...discoveryScreening.skippedDuplicates.map((item) => `${item.company}｜${item.role}：${item.reason}`),
          ...discoveryScreening.rejectedCandidates.map((item) => `${item.company}｜${item.role}：${item.reasons.join('；')}`),
        ].slice(0, 6).join(' ')
        return failure(
          onlyDuplicates ? 'NO_CHANGES' : 'DISCOVERY_NO_ELIGIBLE_CANDIDATES',
          `${onlyDuplicates ? 'All discovered opportunities are already represented in PJSDAS.' : 'No discovered opportunity passed the PJSDAS quality gate.'}${detail ? ` ${detail}` : ''}`,
          false,
        )
      }
      return failure('NO_CHANGES', 'The requested state already matches PJSDAS, so there is nothing to propose.', false)
    }
    if (normalized.length > 24) {
      return failure('PROPOSAL_TOO_LARGE', 'Split this request into smaller PJSDAS proposals of at most 24 normalized operations.', false)
    }

    const expectedWorkspaceFingerprint = await fingerprintWorkspace(snapshot)
    const title = input.title ?? (input.discoveredOpportunities?.length
      ? `ChatGPT 岗位发现 · ${normalized.length} 个候选`
      : `ChatGPT 提议 · ${normalized.length} 项`)
    const changeSet = makeMcpChangeSet(
      title,
      normalized,
      context.workspaceVersion,
      expectedWorkspaceFingerprint,
      now,
    )
    const discoveryReview = discoveryScreening ? discoveryReviewMetadata(discoveryScreening) : undefined
    const signedToken = await createSignedProposalToken(changeSet, context.workspaceVersion, options.signingKey, now, discoveryReview)
    const reviewUrl = buildMcpProposalReviewUrl(signedToken)

    return success({
      status: 'proposal_created',
      applied: false,
      workspaceVersion: context.workspaceVersion,
      changeSetId: changeSet.id,
      title: changeSet.title,
      operationCount: changeSet.operations.length,
      operations: changeSet.operations.map((item) => ({ id: item.id, kind: item.kind, summary: item.summary })),
      skippedDuplicates: discoveryScreening?.skippedDuplicates ?? [],
      rejectedCandidates: discoveryScreening?.rejectedCandidates ?? [],
      deferredCandidates: discoveryScreening?.deferredCandidates ?? [],
      discoveryScreening: discoveryScreening ? {
        received: discoveryScreening.received,
        accepted: discoveryScreening.accepted.length,
        duplicateCount: discoveryScreening.skippedDuplicates.length,
        rejectedCount: discoveryScreening.rejectedCandidates.length,
        deferredCount: discoveryScreening.deferredCandidates.length,
      } : undefined,
      reviewUrl,
      instruction: 'No PJSDAS job-search data has changed. Ask the user to open the signed reviewUrl within 24 hours and explicitly Apply or Discard the ChangeSet in PJSDAS. Prefer component assessment for new web-discovered opportunities: submit bounded fit and opportunity-value components with score, confidence and rationale; PJSDAS derives the two aggregate scores using explicit Decision Rules. Legacy aggregate score fields remain accepted only for backward compatibility. Source-backed Rich Opportunity facts remain separate from AI assessment, and unknown source facts stay unknown. If PJSDAS reports that the local workspace has changed since this proposal was created, sync first and ask for a fresh proposal.',
    })
  } catch (caught) {
    if (caught instanceof WorkspaceSourceError) return failure(caught.code, caught.message, caught.retryable)
    if (caught instanceof z.ZodError) return failure('INVALID_ARGUMENT', caught.issues[0]?.message ?? 'Invalid proposal arguments.', false)
    return failure(
      'PROPOSAL_FAILED',
      caught instanceof Error ? caught.message : 'PJSDAS could not create a review proposal.',
      false,
    )
  }
}
