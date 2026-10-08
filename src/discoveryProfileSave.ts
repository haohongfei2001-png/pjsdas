import type { DiscoveryProfile } from './discoveryProfile.js'
import { discoveryScopeSchema, type DiscoveryScopeInput } from './discoveryScopeSchema.js'

/** Raw historical fields are never sent as a new editable scope. */
export function discoveryProfileSavePayload(profile: DiscoveryProfile): DiscoveryScopeInput {
  return discoveryScopeSchema.parse({
    searchGoal: profile.searchGoal,
    targetRoleQueries: [...profile.targetRoleQueries],
    preferredLocations: [...profile.preferredLocations],
    locationPolicy: profile.locationPolicy,
    mustHave: [...profile.mustHave],
    mustNotHave: [...profile.mustNotHave],
    titleIncludes: [...(profile.titleIncludes ?? [])],
    titleExcludes: [...(profile.titleExcludes ?? [])],
  })
}
