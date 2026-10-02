import type { MutationPrincipal } from './mutationKernel.js'
import { WorkspaceSourceError } from './workspaceSource.js'

/** Separate from ingestion grants. Old email/profile consent never implies v2 management. */
export interface BusinessManagementGrant {
  userId: string
  clientId: string
  consentVersion: 2
  capability: 'workspace.manage'
  grantedAt: string
  revokedAt?: string | null
}
export function assertBusinessManagementGrant(principal: MutationPrincipal, grant: BusinessManagementGrant | undefined) {
  if (!grant || !principal.userId || !principal.clientId || grant.userId !== principal.userId || grant.clientId !== principal.clientId || grant.consentVersion !== 2 || grant.capability !== 'workspace.manage' || grant.revokedAt || !Number.isFinite(Date.parse(grant.grantedAt))) {
    throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Explicit current-account business-management authorization is required.', false)
  }
}
