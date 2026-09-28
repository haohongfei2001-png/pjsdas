import type { GmailSemanticRecord } from './gmailSemanticIntake.js'
import type { PJSDASSnapshot } from './snapshot.js'

export const FRAGMENT_SETTLEMENT_MAX_RECORDS = 100

export function isBoundedFragmentSettlementCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 1 && value <= FRAGMENT_SETTLEMENT_MAX_RECORDS
}

/** Stable authorization fingerprints exclude the parser's per-request observation clock. */
export async function fragmentSafetyDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function fragmentEvidenceShape(records: GmailSemanticRecord[]) {
  return records.map((record) => ({
    sourceRecordId: record.observation.source.sourceRecordId,
    receivedAt: record.receivedAt,
    recruitingRelevant: record.recruitingRelevant ?? null,
    gaps: record.gaps,
    capabilityBoundaries: record.capabilityBoundaries ?? [],
    issueKinds: record.issueKinds ?? [],
    contractVersion: record.observation.contractVersion,
    statementMode: record.observation.statementMode,
    candidates: record.observation.candidates,
  })).sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId))
}

export function fragmentBindingShape(binding: {
  userId: string; googleSubject: string; gmailIntakeConsentVersion?: string; grantedScopes: string[]
}) {
  return {
    userId: binding.userId,
    googleSubject: binding.googleSubject,
    consent: binding.gmailIntakeConsentVersion ?? null,
    scopes: [...binding.grantedScopes].sort(),
  }
}

const BUSINESS_COLLECTIONS = [
  'opportunities', 'processes', 'processEvents', 'actions', 'scheduleNodes',
  'reminderIntents', 'reminderOutbox', 'prep', 'applicationGroups',
  'decisionRequests', 'discoveryInbox',
] as const

function normalized(value: unknown, attemptTime: string): unknown {
  if (typeof value === 'string') return value === attemptTime ? '<request-time>' : value
  if (Array.isArray(value)) return value.map((item) => normalized(item, attemptTime))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalized(item, attemptTime)]))
  }
  return value
}

/** Include the before/after value of every business object changed by the bounded plan. */
export function fragmentBusinessDeltaShape(before: PJSDASSnapshot, after: PJSDASSnapshot, attemptTime: string) {
  const collections = BUSINESS_COLLECTIONS.map((key) => {
    const original = new Map(((before.data[key] ?? []) as { id: string }[]).map((item) => [item.id, item]))
    const projected = new Map(((after.data[key] ?? []) as { id: string }[]).map((item) => [item.id, item]))
    const changed = [...new Set([...original.keys(), ...projected.keys()])].sort()
      .map((id) => ({
        id, before: normalized(original.get(id) ?? null, attemptTime),
        after: normalized(projected.get(id) ?? null, attemptTime),
      }))
      .filter((item) => JSON.stringify(item.before) !== JSON.stringify(item.after))
    return [key, changed] as const
  })
  return Object.fromEntries(collections)
}

export async function fragmentBusinessDeltaDigest(before: PJSDASSnapshot, after: PJSDASSnapshot, attemptTime: string) {
  return fragmentSafetyDigest(fragmentBusinessDeltaShape(before, after, attemptTime))
}
