import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { planningManagementSchema, getPlanningManagementRead, PlanningManagementError } from '../src/planningManagement.js'
import type { MutationPrincipal } from './mutationKernel.js'
import { assertPlanningManagementGrant, type PlanningManagementGrant } from './planningManagementAccess.js'
import { createAuthoritativeCommandExecutor } from './authoritativeCommands.js'
import { createTransactionalWorkspaceStore, type TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const commandId = z.string().trim().min(8).max(160)
export const getPlanningManagementSchema = z.object({}).strict()
export const executePlanningManagementSchema = z.object({ commandId, baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), change: planningManagementSchema }).strict()
export const restorePlanningManagementSchema = z.object({ commandId, targetCommandId: commandId, expectedCompensationFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type PlanningManagementToolName = 'get_planning_management' | 'execute_planning_management' | 'restore_planning_management'
const result = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data })

/** Scoped adapter. Registration is default-off; every invocation requires its own current consent proof. */
export function createPlanningManagementTools(options: {
  principal: MutationPrincipal
  storeOptions: TransactionalWorkspaceStoreOptions
  resolveGrant: (principal: MutationPrincipal) => Promise<PlanningManagementGrant | undefined>
}) {
  const principal = Object.freeze({ ...options.principal })
  const store = createTransactionalWorkspaceStore(options.storeOptions)
  async function authorize(admitted?: PlanningManagementGrant) {
    const grant = await options.resolveGrant(principal)
    assertPlanningManagementGrant(principal, grant)
    if (admitted && (grant.id !== admitted.id || grant.revision !== admitted.revision)) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Planning authorization changed. Start a new explicit request.', false)
    return Object.freeze({ ...grant })
  }
  return { async invoke(name: PlanningManagementToolName, input: unknown): Promise<CallToolResult> {
    try {
      const admitted = await authorize()
      if (name === 'get_planning_management') {
        getPlanningManagementSchema.parse(input)
        const current = await store.readForUser(principal.userId, { preserveRawData: true })
        if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'TodayAction workspace is unavailable.', false)
        if (current.userId !== principal.userId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Workspace owner does not match the current account.', false)
        const data = await getPlanningManagementRead(current.snapshot)
        await authorize(admitted)
        return result({ authorized: true, consentVersion: 4, capability: 'workspace.planning.manage', workspaceVersion: `txn:${current.revision}`, data })
      }
      const executor = createAuthoritativeCommandExecutor({ ...options.storeOptions, resolvePlanningManagementGrant: async () => authorize(admitted) })
      let executed
      let submittedCommandId: string
      if (name === 'execute_planning_management') {
        const parsed = executePlanningManagementSchema.parse(input)
        submittedCommandId = parsed.commandId
        executed = await executor.execute(principal, { commandId: parsed.commandId, baseRevision: parsed.baseRevision, command: { type: 'planning_management', value: parsed.change } })
      } else if (name === 'restore_planning_management') {
        const parsed = restorePlanningManagementSchema.parse(input)
        submittedCommandId = parsed.commandId
        const target = await executor.lookup(principal, parsed.targetCommandId, true)
        if (!target.found || target.operation !== 'planning_management') throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Restore must target a planning-management command in the current account.', false)
        executed = await executor.undo(principal, parsed)
      } else throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Unknown planning-management tool.', false)
      if (executed.outcome !== 'COMMITTED') await authorize(admitted)
      return result({ outcome: executed.outcome, workspaceVersion: `txn:${executed.revision}`, commandId: submittedCommandId, result: executed.result, conflict: executed.conflict })
    } catch (error) {
      const data = error instanceof WorkspaceSourceError || error instanceof PlanningManagementError ? { code: error.code, message: error.message, retryable: error instanceof WorkspaceSourceError ? error.retryable : false }
        : error instanceof z.ZodError ? { code: 'INVALID_ARGUMENT', message: 'Arguments do not match the bounded planning-management schema.', retryable: false }
          : { code: 'MANAGEMENT_FAILED', message: 'No result was confirmed. Read current state before retrying the same command ID.', retryable: false }
      return { ...result(data), isError: true }
    }
  } }
}
