import { z } from 'zod/v4'
import { validateDiscoveryProfile, type DiscoveryProfile } from './discoveryProfile.js'

const list = z.array(z.string().trim().min(1).max(160)).max(30)
export const discoveryScopeShape = {
  searchGoal: z.string().trim().max(2400).optional(),
  targetRoleQueries: list,
  preferredLocations: list,
  locationPolicy: z.enum(['prefer', 'strict']).optional(),
  mustHave: list,
  mustNotHave: list,
  titleIncludes: list.optional(),
  titleExcludes: list.optional(),
}
export const discoveryScopeSchema = z.object(discoveryScopeShape).strict()
export type DiscoveryScopeInput = z.infer<typeof discoveryScopeSchema>

/** Replace the editable scope, retaining every unrelated historical field. */
export function mergeDiscoveryScope(previous: DiscoveryProfile | undefined, raw: unknown, at: string): DiscoveryProfile {
  const input = discoveryScopeSchema.parse(raw)
  const next: DiscoveryProfile = { ...(previous ?? {
    key: 'current', version: 1, locationNotes: '', strengths: [], notes: '',
  }), ...input, searchScopeVersion: 1, searchGoal: input.searchGoal || undefined, titleIncludes: input.titleIncludes ?? [], titleExcludes: input.titleExcludes ?? [],
  locationPolicy: input.locationPolicy ?? 'prefer', updatedAt: at }
  const errors = validateDiscoveryProfile(next)
  if (errors.length) throw new Error(errors[0])
  return next
}
