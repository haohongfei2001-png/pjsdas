import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { planningManagementSchema, getPlanningManagementRead, PlanningManagementError } from '../src/planningManagement.js'
import type { MutationPrincipal } from './mutationKernel.js'
import { assertPlanningManagementGrant, type PlanningManagementGrant } from './planningManagementAccess.js'
import type { createAuthoritativeCommandExecutor } from './authoritativeCommands.js'
import type { WorkspaceSource } from './workspaceSource.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const commandId = z.string().trim().min(8).max(160)
export const getPlanningManagementSchema = z.object({}).strict()
export const executePlanningManagementSchema = z.object({ commandId, baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), change: planningManagementSchema }).strict()
export const restorePlanningManagementSchema = z.object({ commandId, targetCommandId: commandId, expectedCompensationFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type PlanningManagementToolName = 'get_planning_management' | 'execute_planning_management' | 'restore_planning_management'
const result = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data })

/** Source-only adapter: no production runtime, tool catalog or consent handler registers it. */
export function createPlanningManagementTools(options: {
  principal: MutationPrincipal
  source: WorkspaceSource
  createExecutor: (admitted: PlanningManagementGrant) => ReturnType<typeof createAuthoritativeCommandExecutor>
  resolveGrant: (principal: MutationPrincipal) => Promise<PlanningManagementGrant | undefined>
}) {
  const principal = Object.freeze({ ...options.principal })
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
        const current = await options.source.read()
        if (current.context.workspaceOwnerUserId !== principal.userId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Workspace owner does not match the current account.', false)
        const data = await getPlanningManagementRead(current.snapshot)
        await authorize(admitted)
        return result({ authorized: true, consentVersion: 4, capability: 'workspace.planning.manage', workspaceVersion: current.context.workspaceVersion, data })
      }
      const executor = options.createExecutor(admitted)
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
        if (!target.found || target.operation !== 'planning_management') throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Restore must target an planning-management command in the current account.', false)
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
