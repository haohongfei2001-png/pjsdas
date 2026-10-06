import { assertNoScoringInput } from './scoringRetirement.js'
import * as z from 'zod/v4'
import {
  validateDecisionRules, type DecisionRules,
} from './decisionRules.js'
import { SNAPSHOT_VERSION, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import {
  validPlanningDate, validateTimePlanningPreferences, type TimePlanningPreferences,
} from './timePlanningPreferences.js'

const MAX_BYTES = 262144
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const nonempty = (value: object) => Object.values(value).some(item => item !== undefined)
const integer = (min: number, max: number) => z.number().int().min(min).max(max)
const weight = z.number().min(0).max(100)
const weights = z.object({ opportunity: weight, fit: weight, urgency: weight, stage: weight, leverage: weight, delayCost: weight, timeEfficiency: weight }).strict()
const fitWeights = z.object({ roleDirection: weight, skills: weight, education: weight, experience: weight, industry: weight, language: weight, location: weight }).strict()
const opportunityWeights = z.object({ companyQuality: weight, roleGrowth: weight, compensation: weight, careerOptionality: weight, brandValue: weight, industryGrowth: weight, locationValue: weight }).strict()
const portfolioWeights = z.object({ opportunityValue: weight, fit: weight, rolePriority: weight, deadline: weight, applicationEfficiency: weight, evidenceConfidence: weight, overlapPenalty: weight }).strict()
const ruleScalars = {
  hardDeadlineHorizonHours: integer(1, 336), fixedEventHorizonHours: integer(1, 336),
  nearDeadlineStretchMinutes: integer(0, 180), followUpDailyCap: integer(0, 10), prepDailyCap: integer(0, 10),
  upcomingHorizonDays: integer(1, 30), upcomingNodeLimit: integer(1, 50),
  riskCriticalHours: integer(1, 168), riskHighHours: integer(1, 336), riskNearHours: integer(1, 504), riskWatchHours: integer(1, 720),
}
const planningDate = z.string().refine(validPlanningDate, 'An actual calendar date in YYYY-MM-DD format is required.')
const minutes = integer(0, 1440)
const window = z.object({ weekday: integer(0, 6), startMinute: integer(0, 1439), endMinute: integer(1, 1440) }).strict()
  .refine(value => value.endMinute > value.startMinute, 'A work window must end after it starts.')
const windows = z.array(window).max(21).refine(value => !value.some((item, index) => value.some((other, at) => at !== index && other.weekday === item.weekday && other.startMinute < item.endMinute && item.startMinute < other.endMinute)), 'Work windows may not overlap.')
const timePatch = z.object({
  defaultDailyMinutes: minutes.nullable().optional(),
  weeklyWindows: windows.nullable().optional(),
  dateOverrides: z.record(planningDate, minutes.nullable()).refine(nonempty, 'At least one date override is required.').optional(),
}).strict().refine(nonempty, 'A nonempty patch is required.')

export const planningManagementOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('patch_time_preferences'), expectedFingerprint: fingerprint, patch: timePatch }).strict(),
  z.object({ kind: z.literal('reset_time_preferences'), expectedFingerprint: fingerprint }).strict(),
])
export const planningManagementSchema = z.object({ operations: z.array(planningManagementOperationSchema).min(1).max(2) }).strict()
  .refine(value => new Set(value.operations.map(item => configurationType(item.kind))).size === value.operations.length, 'Each configuration may be targeted only once per batch.')
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BYTES, 'Planning management batches must not exceed 256 KiB.')
export type PlanningManagementInput = z.infer<typeof planningManagementSchema>
export type PlanningManagementOperation = z.infer<typeof planningManagementOperationSchema>
export type PlanningManagementObjectType = 'decision_rules' | 'time_preferences'
export type PlanningManagementChange =
  | { type: 'decision_rules'; id: 'current'; before: DecisionRules | null; after: DecisionRules | null }
  | { type: 'time_preferences'; id: 'current'; before: TimePlanningPreferences | null; after: TimePlanningPreferences | null }
export interface PlanningManagementCompensation {
  operation: 'planning_management_restore'
  payload: { changes: PlanningManagementChange[] }
}
export class PlanningManagementError extends Error {
  constructor(public readonly code: 'STALE_TARGET' | 'INVALID_CONFIGURATION' | 'RESTORE_CONFLICT' | 'INVALID_COMPENSATION', message: string) {
    super(message); this.name = 'PlanningManagementError'
  }
}
function configurationType(kind: PlanningManagementOperation['kind']): PlanningManagementObjectType {
  return kind.endsWith('decision_rules') ? 'decision_rules' : 'time_preferences'
}
export function planningManagementObjectRefs(input: PlanningManagementInput) {
  return input.operations.map(operation => ({ type: configurationType(operation.kind), id: 'current' as const }))
}

/** Canonical persisted JSON, including update metadata and the difference between absent and explicit defaults. */
function canonicalJson(value: unknown, compensation = false): string {
  let count = 0
  function canonical(item: unknown, depth: number): unknown {
    if (++count > (compensation ? 4 * 65536 + 32 : 65536) || depth > (compensation ? 37 : 32)) throw new PlanningManagementError('INVALID_CONFIGURATION', 'Planning configuration exceeds its structural limit.')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(value => canonical(value === undefined ? null : value, depth + 1))
    if (item && typeof item === 'object' && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      return Object.fromEntries(Object.keys(item).sort().filter(key => (item as Record<string, unknown>)[key] !== undefined).map(key => [key, canonical((item as Record<string, unknown>)[key], depth + 1)]))
    }
    throw new PlanningManagementError('INVALID_CONFIGURATION', 'Planning configuration must contain finite JSON values.')
  }
  return JSON.stringify(canonical(value, 0))
}
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right)
function boundedConfiguration(value: unknown) {
  const json = canonicalJson(value)
  if (new TextEncoder().encode(json).byteLength > MAX_BYTES) throw new PlanningManagementError('INVALID_CONFIGURATION', 'Each planning configuration must not exceed 256 KiB.')
  return json
}
/** Also fingerprints validated ledger compensation for exact restore consent. */
export async function planningManagementFingerprint(value: unknown) {
  const json = canonicalJson(value, Boolean(value && typeof value === 'object' && 'operation' in value && value.operation === 'planning_management_restore'))
  if (new TextEncoder().encode(json).byteLength > 4 * MAX_BYTES + 4096) throw new PlanningManagementError('INVALID_CONFIGURATION', 'Planning fingerprint evidence exceeds its bounded limit.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
  return [...new Uint8Array(digest)].map(item => item.toString(16).padStart(2, '0')).join('')
}

const timestamp = z.string().refine(value => Number.isFinite(new Date(value).getTime()))
// Persisted rows may contain forward-compatible metadata. Commands cannot write
// arbitrary keys, while compensation must keep the original raw row intact.
const rulesRow = z.object({
  key: z.literal('current'), version: z.literal(1), ...ruleScalars, weights: weights.passthrough(),
  fitComponentWeights: fitWeights.passthrough().optional(), opportunityValueComponentWeights: opportunityWeights.passthrough().optional(),
  portfolioWeights: portfolioWeights.passthrough().optional(), portfolioMinimumCandidateScore: integer(0, 100).optional(), updatedAt: timestamp,
}).passthrough()
const timeRow = z.object({ version: z.literal(1), defaultDailyMinutes: minutes.optional(), weeklyWindows: z.array(window.passthrough()).max(21).optional(), dateOverrides: z.record(planningDate, minutes).optional(), updatedAt: timestamp }).passthrough()
function validateConfiguration(type: PlanningManagementObjectType, value: DecisionRules | TimePlanningPreferences | null) {
  boundedConfiguration(value)
  if (value === null) return
  const schema = type === 'decision_rules' ? rulesRow : timeRow
  if (!schema.safeParse(value).success) throw new PlanningManagementError('INVALID_CONFIGURATION', 'The stored planning configuration is invalid.')
  const errors = type === 'decision_rules' ? validateDecisionRules(value as DecisionRules) : validateTimePlanningPreferences(value as TimePlanningPreferences)
  if (errors.length) throw new PlanningManagementError('INVALID_CONFIGURATION', errors.join(' '))
}

/** Planning may upgrade only the envelope. Missing protected collections need
 * a separate migration; never run unrelated semantic projections or manufacture
 * empty arrays while reading, applying or restoring planning configuration. */
function planningSnapshot(snapshot: PJSDASSnapshot) {
  const protectedCollections = ['scheduleNodes', 'decisionRequests', 'semanticReceipts', 'reminderIntents', 'reminderOutbox'] as const
  if (snapshot?.data && protectedCollections.some(key => !Object.hasOwn(snapshot.data, key) || snapshot.data[key] === undefined)) {
    throw new PlanningManagementError('INVALID_CONFIGURATION', 'The workspace needs a separate snapshot migration or upgrade before planning management: protected data collections are missing.')
  }
  validateSnapshot(snapshot)
  const next = structuredClone(snapshot)
  next.version = SNAPSHOT_VERSION
  validateSnapshot(next)
  return next
}

async function readPlanningConfiguration(snapshot: PJSDASSnapshot) {
  const rules = snapshot.data.decisionRules ?? null
  const time = snapshot.data.timePlanning ?? null
  validateConfiguration('decision_rules', rules)
  validateConfiguration('time_preferences', time)
  return {
    decisionRules: { status: 'retired' as const, code: 'SCORING_RETIRED', historicalDataRetained: rules !== null },
    timePreferences: {
      raw: structuredClone(time),
      effective: { defaultDailyMinutes: time?.defaultDailyMinutes ?? null, weeklyWindows: structuredClone(time?.weeklyWindows ?? null), dateOverrides: structuredClone(time?.dateOverrides ?? {}) },
      fingerprint: await planningManagementFingerprint(time),
    },
  }
}

/** Read only the owner-scoped workspace supplied by the gateway. Missing time
 * preferences deliberately expose unknown capacity rather than a guessed budget. */
export async function getPlanningManagementRead(snapshot: PJSDASSnapshot) {
  return readPlanningConfiguration(planningSnapshot(snapshot))
}

function patchTime(before: TimePlanningPreferences | null, patch: z.infer<typeof timePatch>, at: string): TimePlanningPreferences | null {
  const base: TimePlanningPreferences = before ?? { version: 1, updatedAt: at }
  const after = structuredClone(base)
  for (const key of ['defaultDailyMinutes', 'weeklyWindows'] as const) {
    const value = patch[key]
    if (value === null) delete after[key]
    else if (value !== undefined) Object.assign(after, { [key]: structuredClone(value) })
  }
  if (patch.dateOverrides) {
    const overrides = { ...(before?.dateOverrides ?? {}) }
    for (const [date, value] of Object.entries(patch.dateOverrides)) { if (value === null) delete overrides[date]; else overrides[date] = value }
    if (!equal(overrides, before?.dateOverrides ?? {})) {
      if (Object.keys(overrides).length) after.dateOverrides = overrides
      else delete after.dateOverrides
    }
  }
  return equal(after, base) ? before : after
}

/** Pure atomic reducer; authorization, replay protection, ledger persistence and
 * workspace CAS remain owned by the gateway. It never recalculates saved scores. */
export async function applyPlanningManagement(snapshot: PJSDASSnapshot, raw: unknown, commandId: string, now = new Date()) {
  assertNoScoringInput(raw)
  const input = planningManagementSchema.parse(raw)
  if (commandId.trim().length < 8 || commandId.length > 160) throw new Error('Invalid planning management command identity.')
  const next = planningSnapshot(snapshot)
  const at = now.toISOString()
  const changes: PlanningManagementChange[] = []
  const reviewed = await readPlanningConfiguration(next)
  for (const operation of input.operations) {
    const type = configurationType(operation.kind)
    const current = reviewed.timePreferences
    if (operation.expectedFingerprint !== current.fingerprint) throw new PlanningManagementError('STALE_TARGET', 'The planning configuration changed. Read its exact fingerprint again before applying this command.')
    {
      const before = next.data.timePlanning ?? null
      const after = operation.kind === 'patch_time_preferences' ? patchTime(before, operation.patch, at) : null
      validateConfiguration(type, after)
      if (equal(before, after)) continue
      if (after) { after.updatedAt = at; next.data.timePlanning = after } else delete next.data.timePlanning
      validateConfiguration(type, after)
      changes.push({ type: 'time_preferences', id: 'current', before: structuredClone(before), after: structuredClone(after) })
    }
  }
  const objects = planningManagementObjectRefs(input)
  if (!changes.length) return { status: 'ALREADY_APPLIED' as const, changed: false, snapshot, summary: 'The requested planning configuration is already current.', objects }
  const compensation: PlanningManagementCompensation = { operation: 'planning_management_restore', payload: { changes } }
  assertCompensation(compensation)
  next.data.timeline = [...(next.data.timeline ?? []), {
    id: `planning-management:${commandId}`, kind: 'change_set_applied', category: 'rules', source: 'user_action',
    occurredAt: at, recordedAt: at, title: `Updated ${changes.length} planning configuration(s)`,
    commandId, commandOperation: 'planning_management',
  }]
  next.exportedAt = at
  validateSnapshot(next)
  return { status: 'APPLIED' as const, changed: true, snapshot: next, summary: `Updated ${changes.length} planning configuration(s).`, objects, compensation, compensationFingerprint: await planningManagementFingerprint(compensation) }
}

const compensationSchema = z.object({ operation: z.literal('planning_management_restore'), payload: z.object({ changes: z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('decision_rules'), id: z.literal('current'), before: rulesRow.nullable(), after: rulesRow.nullable() }).strict(),
  z.object({ type: z.literal('time_preferences'), id: z.literal('current'), before: timeRow.nullable(), after: timeRow.nullable() }).strict(),
])).min(1).max(2) }).strict() }).strict()

/** Compensation is loaded only from the owner-scoped command ledger, never from
 * client-provided restore JSON. Audit history is retained by this reducer. */
function assertCompensation(compensation: PlanningManagementCompensation) {
  try {
    if (new TextEncoder().encode(canonicalJson(compensation, true)).byteLength > 4 * MAX_BYTES + 4096 || !compensationSchema.safeParse(compensation).success) throw new Error('Invalid shape.')
    const seen = new Set<PlanningManagementObjectType>()
    for (const change of compensation.payload.changes) {
      if (seen.has(change.type) || equal(change.before, change.after)) throw new Error('Invalid change.')
      seen.add(change.type)
      validateConfiguration(change.type, change.before)
      validateConfiguration(change.type, change.after)
    }
  } catch {
    throw new PlanningManagementError('INVALID_COMPENSATION', 'Planning compensation is invalid.')
  }
}
export function restorePlanningManagement(snapshot: PJSDASSnapshot, compensation: PlanningManagementCompensation, now = new Date()) {
  assertCompensation(compensation)
  const next = planningSnapshot(snapshot)
  for (const change of compensation.payload.changes) {
    const current = change.type === 'decision_rules' ? next.data.decisionRules ?? null : next.data.timePlanning ?? null
    if (!equal(current, change.after)) throw new PlanningManagementError('RESTORE_CONFLICT', 'The planning configuration has newer data; restore cannot overwrite it.')
  }
  for (const change of compensation.payload.changes) {
    if (change.type === 'decision_rules') {
      if (change.before === null) delete next.data.decisionRules
      else next.data.decisionRules = structuredClone(change.before)
    } else {
      if (change.before === null) delete next.data.timePlanning
      else next.data.timePlanning = structuredClone(change.before)
    }
  }
  next.exportedAt = now.toISOString()
  validateSnapshot(next)
  return next
}
