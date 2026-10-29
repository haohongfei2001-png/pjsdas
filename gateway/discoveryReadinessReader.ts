import { createTransactionalWorkspaceStore, type TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'
import { discoveryProfileForSnapshot, isDiscoveryProfileConfigured, isDiscoverySearchScopeConfirmed, validateDiscoveryProfile, type DiscoveryProfile } from '../src/discoveryProfile.js'
import type { DiscoveryReadiness } from '../src/discoveryReadiness.js'

/** Read only the verified account's profile projection, never its full snapshot.
 * This reports no operational paid-search adapter: no budget is inferred from a
 * plan credit, another application, an enabled switch, or prior scheduler checks. */
export function createDiscoveryReadinessReader(options: Pick<TransactionalWorkspaceStoreOptions, 'supabaseUrl' | 'serviceRoleKey' | 'fetchImpl' | 'rowLayoutReader'> & { transactional: boolean }) {
  return async (userId: string): Promise<DiscoveryReadiness> => {
    const unknown: DiscoveryReadiness = { profileConfigured: null, budgetState: 'approval_required' }
    if (!options.transactional || !options.serviceRoleKey || !userId) return unknown
    try {
      const store = createTransactionalWorkspaceStore({ ...options, emptyGmailCheckpoints: false, emptyGmailCheckpointReads: false })
      const projection = await store.readDiscoveryProfileForUser(userId, AbortSignal.timeout(1500))
      if (!projection) return unknown
      const raw: unknown = projection.profile
      if (raw === null || raw === undefined) return { ...unknown, profileConfigured: false }
      if (typeof raw !== 'object' || Array.isArray(raw)) return unknown
      if (validateDiscoveryProfile(raw as DiscoveryProfile).length) return unknown
      const profile = discoveryProfileForSnapshot(raw as DiscoveryProfile)
      return { ...unknown, profileConfigured: isDiscoveryProfileConfigured(profile), scopeConfirmed: isDiscoverySearchScopeConfirmed(profile) }
    } catch { return unknown }
  }
}
