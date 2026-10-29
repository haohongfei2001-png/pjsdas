import { consumerTestClientAllowed, type ConsumerTestCohort } from './consumerTestCohort.js'
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
  consumerCohort?: ConsumerTestCohort
  transactional: boolean
  identity: PjsdasIdentity
  audience: AudienceAccessResult
}) {
  const ownerAllowed = options.enabled === 'enabled' && options.audience.mode === 'allowlist' && options.audience.role === 'owner'
  const consumerAllowed = options.consumerEnabled === 'enabled' && options.audience.mode === 'allowlist' && options.audience.role === 'beta'
    && consumerTestClientAllowed(options.identity.userId, options.identity.oauthClientId, options.consumerCohort)
  if ((!ownerAllowed && !consumerAllowed) || !options.transactional || !options.identity.oauthClientId || !options.audience.allowed) return undefined
  const principal = Object.freeze({ kind: 'delegated_mcp' as const, userId: options.identity.userId, clientId: options.identity.oauthClientId })
  const storeOptions = { supabaseUrl: options.supabaseUrl, serviceRoleKey: options.serviceRoleKey, fetchImpl: options.fetchImpl }
  return Object.freeze({
    business: consumerAllowed ? createConsumerBusinessManagementRuntime({ principal, storeOptions, resolveGrant: createScopedManagementGrantReader('business', storeOptions) }) : undefined,
    opportunity: ownerAllowed ? createOpportunityManagementTools({ principal, storeOptions, resolveGrant: createScopedManagementGrantReader('opportunity', storeOptions) }) : undefined,
    planning: ownerAllowed ? createPlanningManagementTools({ principal, storeOptions, resolveGrant: createScopedManagementGrantReader('planning', storeOptions) }) : undefined,
    discoveryProfile: ownerAllowed ? createDiscoveryProfileManagementTools({ principal, storeOptions, resolveGrant: createScopedManagementGrantReader('discoveryProfile', storeOptions) }) : undefined,
    privateReminder: ownerAllowed ? createPrivateReminderManagementTools({ principal, storeOptions, resolveGrant: createScopedManagementGrantReader('privateReminder', storeOptions) }) : undefined,
  })
}
export type ScopedManagementRuntime = NonNullable<ReturnType<typeof createOwnerScopedManagementRuntime>>
