import type { DiscoveryProfile } from './discoveryProfile.js'

/** Send only supported preferences; retired snapshot fields are not editable. */
export function discoveryProfileSavePayload(profile: DiscoveryProfile): DiscoveryProfile {
  return {
    key: profile.key,
    version: profile.version,
    targetRoleQueries: [...profile.targetRoleQueries],
    preferredLocations: [...profile.preferredLocations],
    locationNotes: profile.locationNotes,
    minimumAnnualCompensationWan: profile.minimumAnnualCompensationWan,
    preferredRoleTypes: profile.preferredRoleTypes ? [...profile.preferredRoleTypes] : undefined,
    locationPolicy: profile.locationPolicy,
    maxReviewCandidates: profile.maxReviewCandidates,
    mustHave: [...profile.mustHave],
    mustNotHave: [...profile.mustNotHave],
    strengths: [...profile.strengths],
    notes: profile.notes,
    updatedAt: profile.updatedAt,
  }
}
