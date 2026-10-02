import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { opportunityManagementSchema, readOpportunityManagement, OpportunityManagementError } from '../src/opportunityManagement.js'
import type { MutationPrincipal } from './mutationKernel.js'
import { assertOpportunityManagementGrant, type OpportunityManagementGrant } from './opportunityManagementAccess.js'
import type { createAuthoritativeCommandExecutor } from './authoritativeCommands.js'
import type { WorkspaceSource } from './workspaceSource.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const commandId = z.string().trim().min(8).max(160)
export const getOpportunityManagementSchema = z.object({ opportunityId: z.string().trim().min(1).max(240) }).strict()
export const executeOpportunityManagementSchema = z.object({ commandId, baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), change: opportunityManagementSchema }).strict()
export const restoreOpportunityManagementSchema = z.object({ commandId, targetCommandId: commandId, expectedCompensationFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type OpportunityManagementToolName = 'get_opportunity_management' | 'execute_opportunity_management' | 'restore_opportunity_management'
const result = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data })

/** Source-only adapter: no production runtime, tool catalog or consent handler registers it. */
export function createOpportunityManagementTools(options: {
  principal: MutationPrincipal
  source: WorkspaceSource
  createExecutor: (admitted: OpportunityManagementGrant) => ReturnType<typeof createAuthoritativeCommandExecutor>
  resolveGrant: (principal: MutationPrincipal) => Promise<OpportunityManagementGrant | undefined>
}) {
  const principal = Object.freeze({ ...options.principal })
  async function authorize(admitted?: OpportunityManagementGrant) {
    const grant = await options.resolveGrant(principal)
    assertOpportunityManagementGrant(principal, grant)
    if (admitted && (grant.id !== admitted.id || grant.revision !== admitted.revision)) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Opportunity authorization changed. Start a new explicit request.', false)
    return Object.freeze({ ...grant })
  }
  return { async invoke(name: OpportunityManagementToolName, input: unknown): Promise<CallToolResult> {
    try {
      const admitted = await authorize()
      if (name === 'get_opportunity_management') {
        const parsed = getOpportunityManagementSchema.parse(input)
        const current = await options.source.read()
        if (current.context.workspaceOwnerUserId !== principal.userId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Workspace owner does not match the current account.', false)
        const data = await readOpportunityManagement(current.snapshot, parsed.opportunityId)
        await authorize(admitted)
        return result({ authorized: true, consentVersion: 3, capability: 'workspace.opportunity.manage', workspaceVersion: current.context.workspaceVersion, data })
      }
      const executor = options.createExecutor(admitted)
      let executed
      let submittedCommandId: string
      if (name === 'execute_opportunity_management') {
        const parsed = executeOpportunityManagementSchema.parse(input)
        submittedCommandId = parsed.commandId
        executed = await executor.execute(principal, { commandId: parsed.commandId, baseRevision: parsed.baseRevision, command: { type: 'opportunity_management', value: parsed.change } })
      } else if (name === 'restore_opportunity_management') {
        const parsed = restoreOpportunityManagementSchema.parse(input)
        submittedCommandId = parsed.commandId
        const target = await executor.lookup(principal, parsed.targetCommandId, true)
        if (!target.found || target.operation !== 'opportunity_management') throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Restore must target an opportunity-management command in the current account.', false)
        executed = await executor.undo(principal, parsed)
      } else throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Unknown opportunity-management tool.', false)
      if (executed.outcome !== 'COMMITTED') await authorize(admitted)
      return result({ outcome: executed.outcome, workspaceVersion: `txn:${executed.revision}`, commandId: submittedCommandId, result: executed.result, conflict: executed.conflict })
    } catch (error) {
      const data = error instanceof WorkspaceSourceError || error instanceof OpportunityManagementError ? { code: error.code, message: error.message, retryable: error instanceof WorkspaceSourceError ? error.retryable : false }
        : error instanceof z.ZodError ? { code: 'INVALID_ARGUMENT', message: 'Arguments do not match the bounded opportunity-management schema.', retryable: false }
          : { code: 'MANAGEMENT_FAILED', message: 'No result was confirmed. Read current state before retrying the same command ID.', retryable: false }
      return { ...result(data), isError: true }
    }
  } }
}
