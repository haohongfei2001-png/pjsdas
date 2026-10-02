import * as z from 'zod/v4'
import type { MutationPrincipal } from './mutationKernel.js'
import { WorkspaceSourceError } from './workspaceSource.js'

/** Separate from ingestion grants. Old email/profile consent never implies v2 management. */
export interface BusinessManagementGrant {
  id: string
  revision: number
  userId: string
  clientId: string
  consentVersion: 2
  capability: 'workspace.manage'
  grantedAt: string
  revokedAt?: string | null
}
const grantSchema = z.object({
  id: z.uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  userId: z.string().min(1), clientId: z.string().min(1),
  consentVersion: z.literal(2), capability: z.literal('workspace.manage'),
  grantedAt: z.iso.datetime({ offset: true }), revokedAt: z.iso.datetime({ offset: true }).nullable().optional(),
}).strict()

export function assertBusinessManagementGrant(principal: MutationPrincipal, grant: BusinessManagementGrant | undefined): asserts grant is BusinessManagementGrant {
  if (!grantSchema.safeParse(grant).success || !grant || principal.kind !== 'delegated_mcp' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(grant.id) || !Number.isSafeInteger(grant.revision) || grant.revision < 1 || !principal.userId || !principal.clientId || grant.userId !== principal.userId || grant.clientId !== principal.clientId || grant.consentVersion !== 2 || grant.capability !== 'workspace.manage' || grant.revokedAt || !Number.isFinite(Date.parse(grant.grantedAt)) || Date.parse(grant.grantedAt) > Date.now()) {
    throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Explicit current-account business-management authorization is required.', false)
  }
}
