import { assertConsumerBusinessManagementGrant, type ConsumerBusinessManagementGrant } from './consumerBusinessManagementAccess.js'
import { assertOpportunityManagementGrant, type OpportunityManagementGrant } from './opportunityManagementAccess.js'
import { assertPlanningManagementGrant, type PlanningManagementGrant } from './planningManagementAccess.js'
import { assertDiscoveryProfileManagementGrant, type DiscoveryProfileManagementGrant } from './discoveryProfileManagementAccess.js'
import { assertPrivateReminderManagementGrant, type PrivateReminderManagementGrant } from './privateReminderManagementAccess.js'
import { SCOPED_MANAGEMENT_CONSENTS, scopedManagementConsentHash, type ScopedManagementDomain } from './scopedManagementConsent.js'
import type { MutationPrincipal } from './mutationKernel.js'
import type { TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'
import { WorkspaceSourceError } from './workspaceSource.js'

interface Grants {
  business: ConsumerBusinessManagementGrant
  opportunity: OpportunityManagementGrant
  planning: PlanningManagementGrant
  discoveryProfile: DiscoveryProfileManagementGrant
  privateReminder: PrivateReminderManagementGrant
}
/** Read-only and exact-domain. A catalogue entry never grants authority. */
export function createScopedManagementGrantReader<K extends ScopedManagementDomain>(domain: K, options: TransactionalWorkspaceStoreOptions) {
  const descriptor = SCOPED_MANAGEMENT_CONSENTS[domain]
  const fetchImpl = options.fetchImpl ?? fetch
  return async (principal: MutationPrincipal): Promise<Grants[K] | undefined> => {
    if (principal.kind !== 'delegated_mcp' || !principal.userId || !principal.clientId) return undefined
    if (!options.serviceRoleKey.trim()) throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Management authorization lookup is not configured.', false)
    const query = new URLSearchParams({ select: 'id,user_id,client_id,capability,consent_version,consent_text_hash,revision,granted_at,revoked_at', user_id: `eq.${principal.userId}`, client_id: `eq.${principal.clientId}`, capability: `eq.${descriptor.capability}`, consent_version: `eq.${descriptor.version}`, revoked_at: 'is.null', limit: '2' })
    let response: Response
    try {
      response = await fetchImpl(`${options.supabaseUrl.replace(/\/+$/, '')}/rest/v1/pjsdas_business_management_grants?${query}`, { headers: { authorization: `Bearer ${options.serviceRoleKey}`, apikey: options.serviceRoleKey } })
    } catch { throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Management authorization lookup is temporarily unavailable.', true) }
    if (!response.ok) throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Management authorization lookup failed.', response.status >= 500 || response.status === 429)
    const rows: unknown = await response.json().catch(() => undefined)
    if (!Array.isArray(rows) || rows.length > 1) throw new WorkspaceSourceError('AUTH_INVALID', 'Management authorization response is invalid.', false)
    if (!rows.length) return undefined
    const row = rows[0]
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.consent_text_hash !== await scopedManagementConsentHash(domain)) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Current explicit consent for this domain is required.', false)
    const grant = { id: row.id, userId: row.user_id, clientId: row.client_id, capability: row.capability, consentVersion: row.consent_version, revision: row.revision, grantedAt: row.granted_at, revokedAt: row.revoked_at }
    // Each assertion validates untrusted row types plus exact principal/version/capability.
    if (domain === 'business') assertConsumerBusinessManagementGrant(principal, grant)
    else if (domain === 'opportunity') assertOpportunityManagementGrant(principal, grant)
    else if (domain === 'planning') assertPlanningManagementGrant(principal, grant)
    else if (domain === 'discoveryProfile') assertDiscoveryProfileManagementGrant(principal, grant)
    else assertPrivateReminderManagementGrant(principal, grant)
    return Object.freeze(grant) as Grants[K]
  }
}
