import * as z from 'zod/v4'
import type { MutationPrincipal } from './mutationKernel.js'
import { WorkspaceSourceError } from './workspaceSource.js'

/** Separate, future explicit consent. A v2 workspace.manage grant can never satisfy this proof. */
export interface OpportunityManagementGrant {
  id: string
  revision: number
  userId: string
  clientId: string
  consentVersion: 3
  capability: 'workspace.opportunity.manage'
  grantedAt: string
  revokedAt?: string | null
}
const grantSchema = z.object({ id: z.uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), userId: z.string().min(1), clientId: z.string().min(1), consentVersion: z.literal(3), capability: z.literal('workspace.opportunity.manage'), grantedAt: z.iso.datetime({ offset: true }), revokedAt: z.iso.datetime({ offset: true }).nullable().optional() }).strict()
export function assertOpportunityManagementGrant(principal: MutationPrincipal, grant: OpportunityManagementGrant | undefined): asserts grant is OpportunityManagementGrant {
  if (!grantSchema.safeParse(grant).success || !grant || principal.kind !== 'delegated_mcp' || !principal.userId || !principal.clientId || grant.userId !== principal.userId || grant.clientId !== principal.clientId || grant.revokedAt || Date.parse(grant.grantedAt) > Date.now()) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Separate explicit version-3 opportunity-management authorization is required.', false)
}
