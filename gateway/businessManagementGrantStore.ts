import { assertBusinessManagementGrant, type BusinessManagementGrant } from './businessManagementAccess.js'
import type { MutationPrincipal } from './mutationKernel.js'
import { WorkspaceSourceError } from './workspaceSource.js'

/** Server-only, read-only adapter. Nothing constructs or activates it by default. */
export function createBusinessManagementGrantReader(options: { supabaseUrl: string; serviceRoleKey: string; fetchImpl?: typeof fetch }) {
  const fetchImpl = options.fetchImpl ?? fetch
  return async (principal: MutationPrincipal): Promise<BusinessManagementGrant | undefined> => {
    if (principal.kind !== 'delegated_mcp' || !principal.userId || !principal.clientId) return undefined
    if (!options.serviceRoleKey.trim()) throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Management grant lookup is not configured.', false)
    const query = new URLSearchParams({ select: 'id,user_id,client_id,capability,consent_version,revision,granted_at,revoked_at', user_id: `eq.${principal.userId}`, client_id: `eq.${principal.clientId}`, capability: 'eq.workspace.manage', consent_version: 'eq.2', revoked_at: 'is.null', limit: '2' })
    let response: Response
    try {
      response = await fetchImpl(`${options.supabaseUrl.replace(/\/+$/, '')}/rest/v1/pjsdas_business_management_grants?${query}`, { headers: { authorization: `Bearer ${options.serviceRoleKey}`, apikey: options.serviceRoleKey } })
    } catch {
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Management grant lookup is temporarily unavailable.', true)
    }
    if (!response.ok) throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Management grant lookup failed.', response.status >= 500 || response.status === 429)
    const rows: unknown = await response.json().catch(() => undefined)
    if (!Array.isArray(rows) || rows.length > 1) throw new WorkspaceSourceError('AUTH_INVALID', 'Management grant response is invalid.', false)
    if (!rows.length) return undefined
    const row = rows[0]
    if (!row || typeof row !== 'object') throw new WorkspaceSourceError('AUTH_INVALID', 'Management grant response is invalid.', false)
    const grant: BusinessManagementGrant = { id: row.id, userId: row.user_id, clientId: row.client_id, capability: row.capability, consentVersion: row.consent_version, revision: row.revision, grantedAt: row.granted_at, revokedAt: row.revoked_at }
    assertBusinessManagementGrant(principal, grant)
    return grant
  }
}
