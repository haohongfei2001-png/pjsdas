import * as z from 'zod/v4'
import type { PjsdasIdentity } from './supabaseIdentity.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export const MANAGEMENT_CONSENT_VERSION = 2 as const
// This is an application capability, NOT a custom Supabase OAuth scope.
export const MANAGEMENT_CAPABILITY = 'workspace.manage' as const
export const managementConsentDecisionSchema = z.object({ authorizationId: z.uuid(), consentVersion: z.literal(MANAGEMENT_CONSENT_VERSION), decision: z.enum(['approve', 'deny']) }).strict()
const providerAuthorizationSchema = z.object({ authorization_id: z.uuid(), user: z.object({ id: z.uuid() }), client: z.object({ id: z.uuid(), name: z.string().min(1) }) })

/** Pure binding validator for a future first-party consent handler.
 * Provider details must come from a server-to-provider request using the verified
 * first-party session. Never accept these details as a browser/tool payload.
 * This helper neither writes a grant nor approves OAuth authorization.
 */
export function bindManagementConsent(identity: PjsdasIdentity, rawDecision: unknown, trustedProviderDetails: unknown) {
  const decision = managementConsentDecisionSchema.parse(rawDecision)
  if (identity.oauthClientId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'A delegated client cannot authorize its own management access.', false)
  const parsed = providerAuthorizationSchema.safeParse(trustedProviderDetails)
  if (!parsed.success) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Explicit management consent requires verified client details; an OAuth auto-redirect is insufficient.', false)
  const details = parsed.data
  if (details.authorization_id !== decision.authorizationId || details.user.id !== identity.userId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Management consent account or request does not match the verified session.', false)
  return { decision: decision.decision, userId: identity.userId, clientId: details.client.id, clientName: details.client.name, consentVersion: MANAGEMENT_CONSENT_VERSION, capability: MANAGEMENT_CAPABILITY }
}

export const managementUpgradeDecisionSchema = z.object({ clientId: z.uuid(), consentVersion: z.literal(MANAGEMENT_CONSENT_VERSION), decision: z.enum(['approve', 'deny']) }).strict()
const providerGrantsSchema = z.array(z.object({ client: z.object({ id: z.uuid(), name: z.string().min(1) }), scopes: z.array(z.string()), granted_at: z.string() }))
/** Existing OAuth connections may auto-redirect. Upgrade their application
 * capability separately, selecting only from the current user's provider list.
 * trustedProviderGrants must be fetched with this first-party session, not read
 * from submitted JSON. This helper does not create a persistent grant.
 */
export function bindManagementUpgrade(identity: PjsdasIdentity, rawDecision: unknown, trustedProviderGrants: unknown) {
  if (identity.oauthClientId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'A delegated client cannot authorize its own management access.', false)
  const decision = managementUpgradeDecisionSchema.parse(rawDecision)
  const parsed = providerGrantsSchema.safeParse(trustedProviderGrants)
  const matches = parsed.success ? parsed.data.filter(item => item.client.id === decision.clientId) : []
  if (matches.length !== 1) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'The selected client is not a verified connection of the current account.', false)
  return { decision: decision.decision, userId: identity.userId, clientId: matches[0].client.id, clientName: matches[0].client.name, consentVersion: MANAGEMENT_CONSENT_VERSION, capability: MANAGEMENT_CAPABILITY }
}
