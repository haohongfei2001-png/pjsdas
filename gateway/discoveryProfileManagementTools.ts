import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { discoveryProfileManagementSchema, getDiscoveryProfileManagementRead, DiscoveryProfileManagementError } from '../src/discoveryProfileManagement.js'
import type { MutationPrincipal } from './mutationKernel.js'
import { assertDiscoveryProfileManagementGrant, type DiscoveryProfileManagementGrant } from './discoveryProfileManagementAccess.js'
import { createAuthoritativeCommandExecutor } from './authoritativeCommands.js'
import { createTransactionalWorkspaceStore, type TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const commandId = z.string().trim().min(8).max(160)
export const getDiscoveryProfileManagementSchema = z.object({}).strict()
export const executeDiscoveryProfileManagementSchema = z.object({ commandId, baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), change: discoveryProfileManagementSchema }).strict()
export const restoreDiscoveryProfileManagementSchema = z.object({ commandId, targetCommandId: commandId, expectedCompensationFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type DiscoveryProfileManagementToolName = 'get_discovery_profile_management' | 'execute_discovery_profile_management' | 'restore_discovery_profile_management'
const result = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data })

/** Scoped adapter. Registration is default-off; every invocation requires its own current consent proof. */
export function createDiscoveryProfileManagementTools(options: {
  principal: MutationPrincipal
  storeOptions: TransactionalWorkspaceStoreOptions
  resolveGrant: (principal: MutationPrincipal) => Promise<DiscoveryProfileManagementGrant | undefined>
}) {
  const principal = Object.freeze({ ...options.principal })
  const store = createTransactionalWorkspaceStore(options.storeOptions)
  async function authorize(admitted?: DiscoveryProfileManagementGrant) {
    const grant = await options.resolveGrant(principal)
    assertDiscoveryProfileManagementGrant(principal, grant)
    if (admitted && (grant.id !== admitted.id || grant.revision !== admitted.revision)) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Discovery-profile authorization changed. Start a new explicit request.', false)
    return Object.freeze({ ...grant })
  }
  return { async invoke(name: DiscoveryProfileManagementToolName, input: unknown): Promise<CallToolResult> {
    try {
      const admitted = await authorize()
      if (name === 'get_discovery_profile_management') {
        getDiscoveryProfileManagementSchema.parse(input)
        const current = await store.readForUser(principal.userId, { preserveRawData: true })
        if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'TodayAction workspace is unavailable.', false)
        if (current.userId !== principal.userId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Workspace owner does not match the current account.', false)
        const data = await getDiscoveryProfileManagementRead(current.snapshot)
        await authorize(admitted)
        return result({ authorized: true, consentVersion: 5, capability: 'workspace.discovery-profile.manage', workspaceVersion: `txn:${current.revision}`, data })
      }
      // Bind admission inside the adapter rather than relying on future runtime wiring.
      const executor = createAuthoritativeCommandExecutor({ ...options.storeOptions, resolveDiscoveryProfileManagementGrant: async () => authorize(admitted) })
      let executed
      let submittedCommandId: string
      if (name === 'execute_discovery_profile_management') {
        const parsed = executeDiscoveryProfileManagementSchema.parse(input)
        submittedCommandId = parsed.commandId
        executed = await executor.execute(principal, { commandId: parsed.commandId, baseRevision: parsed.baseRevision, command: { type: 'discovery_profile_management', value: parsed.change } })
      } else if (name === 'restore_discovery_profile_management') {
        const parsed = restoreDiscoveryProfileManagementSchema.parse(input)
        submittedCommandId = parsed.commandId
        const target = await executor.lookup(principal, parsed.targetCommandId, true)
        if (!target.found || target.operation !== 'discovery_profile_management') throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Restore must target a discovery-profile-management command in the current account.', false)
        executed = await executor.undo(principal, parsed)
      } else throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Unknown discovery-profile-management tool.', false)
      if (executed.outcome !== 'COMMITTED') await authorize(admitted)
      return result({ outcome: executed.outcome, workspaceVersion: `txn:${executed.revision}`, commandId: submittedCommandId, result: executed.result, conflict: executed.conflict })
    } catch (error) {
      const data = error instanceof WorkspaceSourceError || error instanceof DiscoveryProfileManagementError ? { code: error.code, message: error.message, retryable: error instanceof WorkspaceSourceError ? error.retryable : false }
        : error instanceof z.ZodError ? { code: 'INVALID_ARGUMENT', message: 'Arguments do not match the bounded discovery-profile-management schema.', retryable: false }
          : { code: 'MANAGEMENT_FAILED', message: 'No result was confirmed. Read current state before retrying the same command ID.', retryable: false }
      return { ...result(data), isError: true }
    }
  } }
}
