import type { GmailSemanticRecord } from './gmailSemanticIntake.js'

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
