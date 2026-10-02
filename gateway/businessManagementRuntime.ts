import { WorkspaceSourceError } from './workspaceSource.js'
import { createAuthoritativeCommandExecutor } from './authoritativeCommands.js'
import { createBusinessManagementGrantReader } from './businessManagementGrantStore.js'
import { createBusinessManagementTools } from './businessManagementTools.js'
import type { AudienceAccessResult } from './audienceAccess.js'
import type { PjsdasIdentity } from './supabaseIdentity.js'
import type { WorkspaceSource } from './workspaceSource.js'

/** Default off. This switch never creates a grant or expands old OAuth consent. */
export function createOwnerBusinessManagementRuntime(options: {
  enabled?: string
  transactional: boolean
  identity: PjsdasIdentity
  audience: AudienceAccessResult
  source: WorkspaceSource
  supabaseUrl: string
  serviceRoleKey: string
  fetchImpl?: typeof fetch
}) {
  if (options.enabled !== 'enabled' || !options.transactional || !options.identity.oauthClientId || !options.audience.allowed || options.audience.mode !== 'allowlist' || options.audience.role !== 'owner') return undefined
  const resolveGrant = createBusinessManagementGrantReader(options)
  return createBusinessManagementTools({
    principal: { kind: 'delegated_mcp', userId: options.identity.userId, clientId: options.identity.oauthClientId },
    source: options.source,
    resolveGrant,
    createExecutor: admitted => createAuthoritativeCommandExecutor({ ...options, resolveBusinessManagementGrant: async principal => {
      const current = await resolveGrant(principal)
      if (!current || current.id !== admitted.id || current.revision !== admitted.revision) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Management authorization changed. A new explicit request is required.', false)
      return current
    } }),
  })
}
