import { createConsumerBusinessManagementTools } from './consumerBusinessManagementTools.js'
import type { ConsumerBusinessManagementGrant } from './consumerBusinessManagementAccess.js'
import { createAuthoritativeCommandExecutor } from './authoritativeCommands.js'
import { createTransactionalWorkspaceStore, type TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'
import type { MutationPrincipal } from './mutationKernel.js'
import { resolvePlanningTimezone } from '../src/timePlanningPreferences.js'
import { WorkspaceSourceError } from './workspaceSource.js'

/** Internal adapter; constructed only by the default-off consumer runtime. */
export function createConsumerBusinessManagementRuntime(options: {
  principal: MutationPrincipal
  storeOptions: TransactionalWorkspaceStoreOptions
  resolveGrant: (principal: MutationPrincipal) => Promise<ConsumerBusinessManagementGrant | undefined>
}) {
  const principal = Object.freeze({ ...options.principal })
  const store = createTransactionalWorkspaceStore(options.storeOptions)
  return createConsumerBusinessManagementTools({
    principal,
    resolveGrant: options.resolveGrant,
    source: { read: async () => {
      const current = await store.readForUser(principal.userId, { preserveRawData: true })
      if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'TodayAction workspace is unavailable.', false)
      return { snapshot: current.snapshot, context: { now: new Date(), timezone: resolvePlanningTimezone(current.snapshot.data.timePlanning), workspaceOwnerUserId: current.userId, workspaceVersion: `txn:${current.revision}` } }
    } },
    createExecutor: admitted => createAuthoritativeCommandExecutor({ ...options.storeOptions, resolveConsumerBusinessManagementGrant: async currentPrincipal => {
      const current = await options.resolveGrant(currentPrincipal)
      if (!current || current.id !== admitted.id || current.revision !== admitted.revision) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Consumer business authorization changed. Start a new explicit request.', false)
      return current
    } }),
  })
}
