import { discoveryScopeShape } from './discoveryScopeSchema.js'
import { assertNoScoringInput, withoutRetiredScoring } from './scoringRetirement.js'
import * as z from 'zod/v4'
import { discoveryProfileForSnapshot, discoverySearchScope, isDiscoveryProfileConfigured, isDiscoverySearchScopeConfirmed, validateDiscoveryProfile, type DiscoveryProfile } from './discoveryProfile.js'
import { SNAPSHOT_VERSION, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

const MAX_BYTES = 262144
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const roles = z.array(z.enum(['core', 'backup', 'reach', 'lottery', 'practice'])).max(5)
const rawList = z.array(z.string().min(1).max(160).refine(value => value.trim().length > 0)).max(30)
const optionalFields = {
  minimumAnnualCompensationWan: z.number().min(0).max(1000), preferredRoleTypes: roles,
  locationPolicy: z.enum(['prefer', 'strict']), minimumFitScore: z.number().min(0).max(100),
  minimumOpportunityValue: z.number().min(0).max(100), maxReviewCandidates: z.number().int().min(1).max(12),
}
const patch = z.object({ ...discoveryScopeShape,
  locationPolicy: discoveryScopeShape.locationPolicy.nullable(),
  searchGoal: discoveryScopeShape.searchGoal.nullable(),
  titleIncludes: discoveryScopeShape.titleIncludes.nullable(),
  titleExcludes: discoveryScopeShape.titleExcludes.nullable(),
}).partial().strict().refine(value => Object.values(value).some(item => item !== undefined), 'A nonempty patch is required.')
export const discoveryProfileManagementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('patch_discovery_profile'), expectedFingerprint: fingerprint, patch }).strict(),
  z.object({ kind: z.literal('reset_discovery_profile'), expectedFingerprint: fingerprint }).strict(),
]).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BYTES, 'Discovery-profile requests must not exceed 256 KiB.')
export type DiscoveryProfileManagementInput = z.infer<typeof discoveryProfileManagementSchema>
export interface DiscoveryProfileManagementCompensation {
  operation: 'discovery_profile_management_restore'
  payload: { before: DiscoveryProfile | null; after: DiscoveryProfile | null }
}
export class DiscoveryProfileManagementError extends Error {
  constructor(public readonly code: 'STALE_TARGET' | 'INVALID_CONFIGURATION' | 'RESTORE_CONFLICT' | 'INVALID_COMPENSATION', message: string) {
    super(message); this.name = 'DiscoveryProfileManagementError'
  }
}
export function discoveryProfileManagementObjectRefs() { return [{ type: 'discovery_profile', id: 'current' }] }

function canonicalJson(value: unknown, compensation = false): string {
  let count = 0
  function canonical(item: unknown, depth: number): unknown {
    if (++count > (compensation ? 2 * 65536 + 16 : 65536) || depth > (compensation ? 36 : 32)) throw new DiscoveryProfileManagementError('INVALID_CONFIGURATION', 'Discovery profile exceeds its structural limit.')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(value => canonical(value === undefined ? null : value, depth + 1))
    if (item && typeof item === 'object' && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      return Object.fromEntries(Object.keys(item).sort().filter(key => (item as Record<string, unknown>)[key] !== undefined).map(key => [key, canonical((item as Record<string, unknown>)[key], depth + 1)]))
    }
    throw new DiscoveryProfileManagementError('INVALID_CONFIGURATION', 'Discovery profile must contain finite JSON values.')
  }
  return JSON.stringify(canonical(value, 0))
}
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right)
export async function discoveryProfileManagementFingerprint(value: unknown) {
  const json = canonicalJson(value, Boolean(value && typeof value === 'object' && 'operation' in value && value.operation === 'discovery_profile_management_restore'))
  if (new TextEncoder().encode(json).byteLength > 4 * MAX_BYTES) throw new DiscoveryProfileManagementError('INVALID_CONFIGURATION', 'Profile fingerprint evidence exceeds its bounded limit.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
  return [...new Uint8Array(digest)].map(item => item.toString(16).padStart(2, '0')).join('')
}
const row = z.object({
  key: z.literal('current'), version: z.literal(1),
  targetRoleQueries: rawList, preferredLocations: rawList, locationNotes: z.string().max(1200),
  mustHave: rawList, mustNotHave: rawList, strengths: rawList, notes: z.string().max(2400),
  ...Object.fromEntries(Object.entries(optionalFields).map(([key, schema]) => [key, schema.optional()])) as { [K in keyof typeof optionalFields]: z.ZodOptional<(typeof optionalFields)[K]> },
  searchGoal: z.string().max(2400).optional(), titleIncludes: rawList.optional(), titleExcludes: rawList.optional(),
  updatedAt: z.string().refine(value => Number.isFinite(new Date(value).getTime())),
}).passthrough()
function validateProfile(value: DiscoveryProfile | null) {
  if (new TextEncoder().encode(canonicalJson(value)).byteLength > MAX_BYTES) throw new DiscoveryProfileManagementError('INVALID_CONFIGURATION', 'The stored discovery profile exceeds its bounded limit.')
  if (value === null) return
  if (!row.safeParse(value).success) throw new DiscoveryProfileManagementError('INVALID_CONFIGURATION', 'The stored discovery profile is invalid.')
  const errors = validateDiscoveryProfile(value)
  if (errors.length) throw new DiscoveryProfileManagementError('INVALID_CONFIGURATION', errors.join(' '))
}
/** Preserve all raw business data. Missing collections require a separate explicit migration. */
function rawSnapshot(snapshot: PJSDASSnapshot) {
  const protectedCollections = ['scheduleNodes', 'decisionRequests', 'semanticReceipts', 'reminderIntents', 'reminderOutbox'] as const
  if (snapshot?.data && protectedCollections.some(key => !Object.hasOwn(snapshot.data, key) || snapshot.data[key] === undefined)) throw new DiscoveryProfileManagementError('INVALID_CONFIGURATION', 'The workspace needs a separate snapshot migration before discovery-profile management.')
  validateSnapshot(snapshot)
  const next = structuredClone(snapshot)
  next.version = SNAPSHOT_VERSION
  validateSnapshot(next)
  return next
}
export async function getDiscoveryProfileManagementRead(snapshot: PJSDASSnapshot) {
  const current = rawSnapshot(snapshot).data.discoveryProfile ?? null
  validateProfile(current)
  const effective = discoveryProfileForSnapshot(current ?? undefined)
  return { raw: withoutRetiredScoring(current), effective: discoverySearchScope(effective), fingerprint: await discoveryProfileManagementFingerprint(current), configured: isDiscoveryProfileConfigured(effective), scopeConfirmed: isDiscoverySearchScopeConfirmed(effective) }
}
/** This only stores explicitly supplied preferences. It never starts a search, changes a budget,
 * rewrites discovered facts, infers preferences or changes provider/credential settings. */
export async function applyDiscoveryProfileManagement(snapshot: PJSDASSnapshot, raw: unknown, commandId: string, now = new Date()) {
  assertNoScoringInput(raw)
  const input = discoveryProfileManagementSchema.parse(raw)
  if (commandId.trim().length < 8 || commandId.length > 160) throw new Error('Invalid discovery-profile command identity.')
  const next = rawSnapshot(snapshot)
  const before = next.data.discoveryProfile ?? null
  validateProfile(before)
  if (input.expectedFingerprint !== await discoveryProfileManagementFingerprint(before)) throw new DiscoveryProfileManagementError('STALE_TARGET', 'The discovery profile changed. Read its exact fingerprint before applying a new request.')
  const at = now.toISOString()
  let after: DiscoveryProfile | null = null
  if (input.kind === 'patch_discovery_profile') {
    const base: DiscoveryProfile = before ?? { key: 'current', version: 1, targetRoleQueries: [], preferredLocations: [], locationNotes: '', mustHave: [], mustNotHave: [], strengths: [], notes: '', updatedAt: at }
    after = structuredClone(base)
    for (const [key, value] of Object.entries(input.patch)) {
      if (value === null) delete (after as unknown as Record<string, unknown>)[key]
      else if (value !== undefined) Object.assign(after, { [key]: structuredClone(value) })
    }
    // A small edit cannot silently consent to ignoring historical constraints.
    // Explicitly replacing every required scope collection confirms this model;
    // legacy notes/ratings remain in the raw row and in Undo compensation.
    if (['targetRoleQueries', 'preferredLocations', 'mustHave', 'mustNotHave'].every(key => Object.hasOwn(input.patch, key))) after.searchScopeVersion = 1
    // An effective no-op on an absent row must not manufacture explicit defaults.
    if (equal(after, base)) after = before
  }
  validateProfile(after)
  const objects = discoveryProfileManagementObjectRefs()
  if (equal(before, after)) return { status: 'ALREADY_APPLIED' as const, changed: false, snapshot, summary: 'The discovery profile is already current.', objects }
  if (after) { after.updatedAt = at; next.data.discoveryProfile = after } else delete next.data.discoveryProfile
  validateProfile(after)
  const compensation: DiscoveryProfileManagementCompensation = { operation: 'discovery_profile_management_restore', payload: { before: structuredClone(before), after: structuredClone(after) } }
  assertCompensation(compensation)
  next.data.timeline = [...(next.data.timeline ?? []), { id: `discovery-profile-management:${commandId}`, kind: 'change_set_applied', category: 'data', source: 'user_action', occurredAt: at, recordedAt: at, title: 'Updated discovery preferences', commandId, commandOperation: 'discovery_profile_management' }]
  next.exportedAt = at
  validateSnapshot(next)
  return { status: 'APPLIED' as const, changed: true, snapshot: next, summary: 'Updated discovery preferences for subsequent runs.', objects, compensation, compensationFingerprint: await discoveryProfileManagementFingerprint(compensation) }
}
const compensationSchema = z.object({ operation: z.literal('discovery_profile_management_restore'), payload: z.object({ before: row.nullable(), after: row.nullable() }).strict() }).strict()
function assertCompensation(compensation: DiscoveryProfileManagementCompensation) {
  try {
    if (new TextEncoder().encode(canonicalJson(compensation, true)).byteLength > 4 * MAX_BYTES || !compensationSchema.safeParse(compensation).success || equal(compensation.payload.before, compensation.payload.after)) throw new Error('Invalid shape or change.')
    validateProfile(compensation.payload.before); validateProfile(compensation.payload.after)
  } catch { throw new DiscoveryProfileManagementError('INVALID_COMPENSATION', 'Discovery-profile compensation is invalid.') }
}
/** Only owner-ledger evidence reaches this function, never caller-supplied compensation JSON. */
export function restoreDiscoveryProfileManagement(snapshot: PJSDASSnapshot, compensation: DiscoveryProfileManagementCompensation, now = new Date()) {
  assertCompensation(compensation)
  const next = rawSnapshot(snapshot)
  if (!equal(next.data.discoveryProfile ?? null, compensation.payload.after)) throw new DiscoveryProfileManagementError('RESTORE_CONFLICT', 'The discovery profile has newer data; restore cannot overwrite it.')
  if (compensation.payload.before === null) delete next.data.discoveryProfile
  else next.data.discoveryProfile = structuredClone(compensation.payload.before)
  next.exportedAt = now.toISOString()
  validateSnapshot(next)
  return next
}
