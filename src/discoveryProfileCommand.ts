import { normalizeDiscoveryProfile, validateDiscoveryProfile, type DiscoveryProfile } from './discoveryProfile.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

export function applyDiscoveryProfileCommand(snapshot: PJSDASSnapshot, profile: DiscoveryProfile, now = new Date()) {
  const next = upgradeSnapshotToLatest(snapshot)
  const previous = next.data.discoveryProfile
  const normalized = normalizeDiscoveryProfile(profile, now.toISOString())
  const errors = validateDiscoveryProfile(normalized)
  if (errors.length) throw new Error(errors[0])
  next.data.discoveryProfile = normalized
  next.exportedAt = now.toISOString()
  validateSnapshot(next)
  return {
    status: 'APPLIED' as const,
    changed: true,
    snapshot: next,
    summary: 'Saved first-party Discovery Profile preferences.',
    compensation: { operation: 'restore_discovery_profile', payload: { profile: previous } },
  }
}
