import { z } from 'zod/v4'
import type { SemanticCandidate, SemanticIntakeObservation } from '../src/model.js'
import { isExplicitActionArrangement } from '../src/scheduleEligibility.js'
import { isPreparationCandidate } from '../src/preparationRetirement.js'
import { validSourceDate, validSourceInstant, validSourceDeadline } from '../src/sourceCalendar.js'
import { normalizedUserJobFacts } from '../src/opportunityCreation.js'
import { userJobFactsShape } from '../src/userJobFactsSchema.js'
import { semanticIntakeSchema } from './semanticIntake.js'

const boundedText = (max: number) => z.string().trim().min(1).max(max)
const date = z.string().refine(validSourceDate, 'Expected a real calendar date.')
const instant = z.string().refine(validSourceInstant, 'Expected a real offset-aware instant.')
const timezone = boundedText(120).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}, 'Expected an IANA timezone.')
const precision = z.enum(['date', 'datetime'])
const target = z.object({ company: boundedText(120).optional(), role: boundedText(180).optional() }).strict()
const evidence = z.object({ start: z.number().int().min(0), end: z.number().int().min(1), quote: z.string().min(1).max(8_000) }).strict()
const common = { evidence, confidence: z.enum(['high', 'medium', 'low']) }

// No legacy/system estimates, invented provenance, floating clocks or end-of-day projection.
const temporal = z.discriminatedUnion('shape', [
  z.object({ shape: z.literal('fixed_range'), precision: z.literal('datetime'), timezone,
    startAt: instant, endAt: instant.optional() }).strict(),
  z.object({ shape: z.literal('availability_window'), precision: z.literal('datetime'), timezone,
    startAt: instant, endAt: instant, latestStartAt: instant.optional() }).strict(),
  z.object({ shape: z.literal('deadline'), precision: z.literal('datetime'), timezone, deadlineAt: instant }).strict(),
  z.object({ shape: z.literal('date_only'), precision: z.literal('date'), timezone, date }).strict(),
]).superRefine((value, ctx) => {
  if ('endAt' in value && value.endAt && Date.parse(value.endAt) <= Date.parse(value.startAt)) {
    ctx.addIssue({ code: 'custom', path: ['endAt'], message: 'End must follow start.' })
  }
  if (value.shape === 'availability_window' && value.latestStartAt
    && (Date.parse(value.latestStartAt) < Date.parse(value.startAt) || Date.parse(value.latestStartAt) > Date.parse(value.endAt))) {
    ctx.addIssue({ code: 'custom', path: ['latestStartAt'], message: 'Latest start must be within the window.' })
  }
})

const actionTemporal = temporal.refine(value => value.shape === 'fixed_range', 'A timed Action needs an explicit start; day-only plans use plannedDate.')

const providerCandidate = z.discriminatedUnion('kind', [
  z.object({ ...common, ...userJobFactsShape, kind: z.literal('user_opportunity') }).strict(),
  z.object({ ...common, kind: z.literal('application_action'), target,
    plannedDate: date.optional(), scheduledTemporal: actionTemporal.optional() }).strict(),
  z.object({ ...common, kind: z.literal('application_submitted'), target, occurredAt: instant.optional() }).strict(),
  z.object({ ...common, kind: z.literal('manual_action'), title: boundedText(300),
    plannedDate: date.optional(), scheduledTemporal: actionTemporal.optional() }).strict(),
  z.object({ ...common, kind: z.literal('process_event'), target,
    eventType: z.enum(['assessment_invite', 'written_test_invite', 'interview_invite', 'offer', 'rejection', 'status_update', 'other']),
    temporal: temporal.optional(), timingMode: z.enum(['fixed', 'deadline']).optional(), occurredAt: instant.optional(), notes: boundedText(800).optional() }).strict(),
  z.object({ ...common, kind: z.literal('opportunity_deadline'), target, deadline: boundedText(100), precision }).strict(),
])

/** Offline v1 protocol, NOT an enabled model route. Unsupported operations must be
 * reported as clarifications. A provider cannot choose owners, source/receipt IDs,
 * statement mode, grants, stable object IDs, commands, or external actions.
 * Schema acceptance and synthetic tests do not establish model understanding. */
export const aiCaptureProviderOutputSchema = z.object({
  contractVersion: z.literal(1),
  candidates: z.array(providerCandidate).max(12),
  clarifications: z.array(z.object({
    candidateIndex: z.number().int().min(0).max(11).nullable(),
    field: z.enum(['identity', 'time', 'intent', 'unsupported']),
    question: boundedText(500),
  }).strict()).max(12),
}).strict().superRefine((value, ctx) => {
  value.clarifications.forEach((item, index) => {
    if (item.candidateIndex !== null && item.candidateIndex >= value.candidates.length) {
      ctx.addIssue({ code: 'custom', path: ['clarifications', index, 'candidateIndex'], message: 'Unknown candidate index.' })
    }
  })
})
export type AiCaptureProviderOutput = z.infer<typeof aiCaptureProviderOutputSchema>

const contextSchema = z.object({
  trigger: z.literal('explicit_user_request'),
  ownerKey: boundedText(240),
  inputId: semanticIntakeSchema.shape.inputId,
  receiptId: boundedText(240),
  text: z.string().min(1).max(8_000).refine(value => Boolean(value.trim())),
  timezone,
  // Immutable interpretation anchor, not a new wall-clock reading at confirmation.
  referenceTime: instant,
  workspaceRevision: boundedText(240),
  source: semanticIntakeSchema.shape.source,
  statementMode: semanticIntakeSchema.shape.statementMode,
  temporalResolutionBasis: z.enum(['user_explicit', 'source_explicit']),
  opportunities: z.array(z.object({ opportunityId: boundedText(240), company: boundedText(120), role: boundedText(180) }).strict()).max(10_000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.opportunities.map(item => item.opportunityId)).size !== value.opportunities.length) {
    ctx.addIssue({ code: 'custom', path: ['opportunities'], message: 'Duplicate trusted opportunity IDs.' })
  }
})
export type AiCaptureTrustedContext = z.input<typeof contextSchema>
export interface AiCaptureIssue {
  candidateIndex: number | null
  field: 'identity' | 'time' | 'intent' | 'unsupported' | 'evidence' | 'confidence' | 'output'
  message: string
}
export interface AiCaptureReview {
  status: 'ready_for_review' | 'clarification_required' | 'no_write' | 'invalid_output' | 'stale'
  statementMode: AiCaptureTrustedContext['statementMode']
  candidates: readonly SemanticCandidate[]
  issues: readonly AiCaptureIssue[]
}
export type AiCaptureConfirmation =
  | { status: 'blocked'; reason: 'stale' | 'unrecognized_review' | 'review_not_ready' | 'explicit_confirmation_required' }
  | { status: 'confirmed_candidates'; ownerKey: string; receiptId: string; expectedWorkspaceRevision: string; observation: SemanticIntakeObservation }

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const identityText = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()

/** In-memory, candidate-only review boundary. There is no transport, UI debounce,
 * persistence, command execution or authorization grant here. The caller supplies
 * authenticated context, reference inventory and all receipt/source identifiers.
 * This private context is not a provider request and must not be sent wholesale.
 * A future adapter must separately authorize the provider/data/spend and perform
 * domain validation + atomic whole-batch CAS at write time, with a durable receipt
 * ledger rejecting changed payloads under reused IDs across sessions. Never pass candidates
 * through submitWebSemanticCapture's shortcut, which changes statementMode.
 * Reviews cannot be serialized/restored as authority; only the latest exact review
 * object in this session can be confirmed. Reconfirmation yields the same IDs;
 * a confirmed session cannot reinterpret those IDs with different facts. */
export function createAiCaptureContractSession(trustedContext: AiCaptureTrustedContext) {
  const context = freeze(contextSchema.parse(trustedContext))
  const binding = JSON.stringify(context)
  let latest: AiCaptureReview | undefined
  let observation: SemanticIntakeObservation | undefined
  let finalized = false
  function isCurrent(current: AiCaptureTrustedContext) {
    const parsed = contextSchema.safeParse(current)
    return parsed.success && JSON.stringify(parsed.data) === binding
  }
  function review(status: AiCaptureReview['status'], candidates: SemanticCandidate[], issues: AiCaptureIssue[]) {
    latest = freeze({ status, statementMode: context.statementMode, candidates, issues })
    return latest
  }
  return Object.freeze({
    evaluate(rawOutput: unknown, current: AiCaptureTrustedContext): AiCaptureReview {
      if (finalized) throw new Error('This capture is confirmed; a new interpretation requires new trusted input and receipt IDs.')
      observation = undefined
      if (!isCurrent(current)) return review('stale', [], [])
      const parsed = aiCaptureProviderOutputSchema.safeParse(rawOutput)
      if (!parsed.success) return review('invalid_output', [], [{ candidateIndex: null, field: 'output', message: 'Provider output does not match the bounded contract.' }])
      const issues: AiCaptureIssue[] = parsed.data.clarifications.map(item => ({ candidateIndex: item.candidateIndex, field: item.field, message: item.question }))
      const candidates: SemanticCandidate[] = []
      const singletonTargets = new Set<string>()
      parsed.data.candidates.forEach((proposal, index) => {
        const issue = (field: AiCaptureIssue['field'], message: string) => issues.push({ candidateIndex: index, field, message })
        const { evidence: span, confidence, ...facts } = proposal
        if (span.end <= span.start || span.end > context.text.length || context.text.slice(span.start, span.end) !== span.quote) {
          issue('evidence', 'Evidence must match an exact UTF-16 span of the original input.')
        }
        if (confidence !== 'high') issue('confidence', 'Uncertain interpretation requires clarification.')
        let resolvedTarget: SemanticCandidate['target']
        if ('target' in facts) {
          const matches = facts.target.company && facts.target.role ? context.opportunities.filter(item =>
            identityText(item.company) === identityText(facts.target.company!) && identityText(item.role) === identityText(facts.target.role!)) : []
          if (matches.length !== 1) issue('identity', 'Resolve one exact existing job before confirming this batch.')
          else resolvedTarget = { opportunityId: matches[0].opportunityId, company: matches[0].company, role: matches[0].role }
        }
        if (facts.kind === 'user_opportunity') {
          try { normalizedUserJobFacts(facts) } catch { issue('identity', 'Job facts require valid company, role, source and deadline values.') }
          if (context.opportunities.some(item => identityText(item.company) === identityText(facts.company) && identityText(item.role) === identityText(facts.role))) {
            issue('identity', 'A saved job may match; clarify before proposing another identity.')
          }
        }
        if (facts.kind === 'opportunity_deadline' && !validSourceDeadline(facts.deadline, facts.precision)) issue('time', 'Deadline must be a real date or offset-aware instant.')
        if (facts.kind === 'process_event') {
          if (facts.eventType.endsWith('_invite')) {
            if (!facts.temporal) issue('time', 'An invitation needs explicit temporal facts or clarification.')
            else if (facts.temporal.shape === 'date_only' && !facts.timingMode) issue('time', 'Clarify whether the date is an appointment or a completion deadline.')
            else if (facts.timingMode && facts.temporal.shape !== 'date_only'
              && facts.timingMode !== (facts.temporal.shape === 'fixed_range' ? 'fixed' : 'deadline')) issue('time', 'Timing mode must agree with the explicit temporal shape.')
          } else if (facts.temporal || facts.timingMode) issue('time', 'A non-appointment process fact cannot carry an arrangement.')
        }
        if (('plannedDate' in facts && facts.plannedDate) && ('scheduledTemporal' in facts && facts.scheduledTemporal)) {
          issue('time', 'Use one explicit plan representation rather than competing dates and times.')
        }
        const candidate: SemanticCandidate = {
          ...facts,
          id: `ai-capture:${index + 1}`,
          ...('target' in facts ? { target: resolvedTarget } : {}),
          ...('temporal' in facts && facts.temporal ? { temporal: { ...facts.temporal, resolutionBasis: context.temporalResolutionBasis },
            timingMode: facts.timingMode ?? (facts.temporal.shape === 'fixed_range' ? 'fixed' : 'deadline') } : {}),
          ...('scheduledTemporal' in facts && facts.scheduledTemporal ? { scheduledTemporal: { ...facts.scheduledTemporal, resolutionBasis: context.temporalResolutionBasis } } : {}),
          objectConfidence: confidence, eventConfidence: confidence, temporalConfidence: confidence,
          evidenceRefs: [`${context.source.sourceRecordId}#text=${span.start}:${span.end}`],
          sourceVersionRefs: context.source.sourceVersion ? [context.source.sourceVersion] : [],
        } as SemanticCandidate
        if ('scheduledTemporal' in candidate && candidate.scheduledTemporal && !isExplicitActionArrangement(candidate.scheduledTemporal)) issue('time', 'Action arrangements require an explicit user-chosen time.')
        if (isPreparationCandidate(candidate)) issue('unsupported', 'Preparation tasks are retired.')
        const singletonKey = facts.kind === 'user_opportunity'
          ? JSON.stringify(['user_opportunity', identityText(facts.company), identityText(facts.role)])
          : ['application_action', 'application_submitted', 'opportunity_deadline'].includes(facts.kind) && resolvedTarget?.opportunityId
            ? `${facts.kind}:${resolvedTarget.opportunityId}` : undefined
        if (singletonKey) {
          if (singletonTargets.has(singletonKey)) issue('intent', 'Competing facts for the same job require one resolved proposal; array order is not intent.')
          singletonTargets.add(singletonKey)
        }
        candidates.push(candidate)
      })
      // Questions, quotations, examples and rewrite requests never gain intent from
      // provider output, including when the output proposes a plausible action.
      if (!['assertion', 'current_intent'].includes(context.statementMode)) return review('no_write', candidates, issues)
      if (issues.length) return review('clarification_required', candidates, issues)
      if (!candidates.length) return review('no_write', [], [])
      const bound = semanticIntakeSchema.safeParse({ contractVersion: 1, inputId: context.inputId, source: context.source,
        statementMode: context.statementMode, originalText: context.text, candidates })
      if (!bound.success) return review('invalid_output', [], [{ candidateIndex: null, field: 'output', message: 'Candidate facts are incompatible with Semantic Intake.' }])
      observation = freeze(bound.data as SemanticIntakeObservation)
      return review('ready_for_review', candidates, [])
    },
    confirm(selected: AiCaptureReview, current: AiCaptureTrustedContext, trigger: 'explicit_user_confirmation'): AiCaptureConfirmation {
      if (trigger !== 'explicit_user_confirmation') return { status: 'blocked', reason: 'explicit_confirmation_required' }
      if (!isCurrent(current)) return { status: 'blocked', reason: 'stale' }
      if (selected !== latest) return { status: 'blocked', reason: 'unrecognized_review' }
      if (selected.status !== 'ready_for_review' || !observation) return { status: 'blocked', reason: 'review_not_ready' }
      finalized = true
      return freeze({ status: 'confirmed_candidates', ownerKey: context.ownerKey, receiptId: context.receiptId,
        expectedWorkspaceRevision: context.workspaceRevision, observation })
    },
  })
}
