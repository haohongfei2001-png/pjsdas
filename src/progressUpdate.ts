export * from './progressUpdateV4.js'
export { parseProgressUpdate } from './progressInputPolicy.js'
export type { CanonicalJobReference } from './progressInputPolicy.js'

/** Stable identity for an explicitly confirmed submission in the older adapters. */
export function progressSubmissionProofId(operation: { id: string; opportunityId: string }) {
  return `progress-submission:${JSON.stringify([operation.opportunityId, operation.id])}`
}
