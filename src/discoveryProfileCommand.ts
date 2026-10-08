import { mergeDiscoveryScope } from './discoveryScopeSchema.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

export function applyDiscoveryProfileCommand(snapshot: PJSDASSnapshot, profile: unknown, now = new Date()) {
  const next = upgradeSnapshotToLatest(snapshot)
  const previous = next.data.discoveryProfile
  const normalized = mergeDiscoveryScope(previous, profile, now.toISOString())
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
