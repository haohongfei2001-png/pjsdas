import { createConsumerBusinessManagementRuntime } from './consumerBusinessManagementRuntime.js'
import { createScopedManagementGrantReader } from './scopedManagementGrantStore.js'
import { createOpportunityManagementTools } from './opportunityManagementTools.js'
import { createPlanningManagementTools } from './planningManagementTools.js'
import { createDiscoveryProfileManagementTools } from './discoveryProfileManagementTools.js'
import { createPrivateReminderManagementTools } from './privateReminderManagementTools.js'
import type { AudienceAccessResult } from './audienceAccess.js'
import type { PjsdasIdentity } from './supabaseIdentity.js'
import type { TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'

/** Separate default-off source wiring. Does not change v2 or issue any grant. */
export function createOwnerScopedManagementRuntime(options: TransactionalWorkspaceStoreOptions & {
  enabled?: string
  consumerEnabled?: string
  transactional: boolean
  identity: PjsdasIdentity
  audience: AudienceAccessResult
}) {
  const ownerAllowed = options.enabled === 'enabled' && options.audience.mode === 'allowlist' && options.audience.role === 'owner'
  const consumerAllowed = options.consumerEnabled === 'enabled' && ((options.audience.mode === 'legacy' && options.audience.role === 'legacy') || (options.audience.mode === 'allowlist' && ['owner', 'beta'].includes(options.audience.role ?? '')))
  if ((!ownerAllowed && !consumerAllowed) || !options.transactional || !options.identity.oauthClientId || !options.audience.allowed) return undefined
  const principal = Object.freeze({ kind: 'delegated_mcp' as const, userId: options.identity.userId, clientId: options.identity.oauthClientId })
  const storeOptions = { supabaseUrl: options.supabaseUrl, serviceRoleKey: options.serviceRoleKey, fetchImpl: options.fetchImpl }
  return Object.freeze({
    business: consumerAllowed ? createConsumerBusinessManagementRuntime({ principal, storeOptions, resolveGrant: createScopedManagementGrantReader('business', storeOptions) }) : undefined,
    opportunity: createOpportunityManagementTools({ principal, storeOptions, resolveGrant: createScopedManagementGrantReader('opportunity', storeOptions) }),
    planning: createPlanningManagementTools({ principal, storeOptions, resolveGrant: createScopedManagementGrantReader('planning', storeOptions) }),
    discoveryProfile: createDiscoveryProfileManagementTools({ principal, storeOptions, resolveGrant: createScopedManagementGrantReader('discoveryProfile', storeOptions) }),
    privateReminder: createPrivateReminderManagementTools({ principal, storeOptions, resolveGrant: createScopedManagementGrantReader('privateReminder', storeOptions) }),
  })
}
export type ScopedManagementRuntime = NonNullable<ReturnType<typeof createOwnerScopedManagementRuntime>>
