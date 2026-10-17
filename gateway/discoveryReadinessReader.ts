import { discoveryProfileForSnapshot, isDiscoveryProfileConfigured, isDiscoverySearchScopeConfirmed, validateDiscoveryProfile, type DiscoveryProfile } from '../src/discoveryProfile.js'
import type { DiscoveryReadiness } from '../src/discoveryReadiness.js'

/** Read only the verified account's profile projection, never its full snapshot.
 * This reports no operational paid-search adapter: no budget is inferred from a
 * plan credit, another application, an enabled switch, or prior scheduler checks. */
export function createDiscoveryReadinessReader(options: { transactional: boolean; supabaseUrl: string; serviceRoleKey: string; fetchImpl?: typeof fetch }) {
  return async (userId: string): Promise<DiscoveryReadiness> => {
    const unknown: DiscoveryReadiness = { profileConfigured: null, budgetState: 'approval_required' }
    if (!options.transactional || !options.serviceRoleKey || !userId) return unknown
    try {
      const query = new URLSearchParams({ select: 'user_id,profile:snapshot->data->discoveryProfile', user_id: `eq.${userId}`, limit: '1' })
      const response = await (options.fetchImpl ?? fetch)(`${options.supabaseUrl.replace(/\/+$/, '')}/rest/v1/pjsdas_workspaces?${query}`, { headers: { authorization: `Bearer ${options.serviceRoleKey}`, apikey: options.serviceRoleKey }, signal: AbortSignal.timeout(1500) })
      if (!response.ok) return unknown
      const rows: unknown = await response.json()
      if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || rows[0].user_id !== userId) return unknown
      const raw: unknown = rows[0].profile
      if (raw === null || raw === undefined) return { ...unknown, profileConfigured: false }
      if (typeof raw !== 'object' || Array.isArray(raw)) return unknown
      if (validateDiscoveryProfile(raw as DiscoveryProfile).length) return unknown
      const profile = discoveryProfileForSnapshot(raw as DiscoveryProfile)
      return { ...unknown, profileConfigured: isDiscoveryProfileConfigured(profile), scopeConfirmed: isDiscoverySearchScopeConfirmed(profile) }
    } catch { return unknown }
  }
}
