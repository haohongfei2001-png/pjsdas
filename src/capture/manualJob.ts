import { normalizedUserJobFacts, type UserJobFacts } from '../opportunityCreation.js'
import type { SemanticCandidate } from '../model.js'
const prefix = 'TodayAction manual job v1\n'
export function manualJobDraft(facts: UserJobFacts) { return prefix + JSON.stringify(facts) }
export function readManualJobDraft(text: string): UserJobFacts | undefined {
  if (!text.startsWith(prefix)) return undefined
  try {
    const value = JSON.parse(text.slice(prefix.length))
    if (!value || typeof value.company !== 'string' || typeof value.role !== 'string') return undefined
    return value
  } catch { return undefined }
}
export function manualJobCandidate(facts: UserJobFacts): SemanticCandidate {
  return { ...normalizedUserJobFacts(facts), id: 'manual-job', kind: 'user_opportunity',
    objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }
}
