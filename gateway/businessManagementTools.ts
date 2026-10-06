import { assertNoScoringInput, ScoringRetiredError } from '../src/scoringRetirement.js'
import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { businessManagementSchema, businessManagementReadSchema, readBusinessManagement } from '../src/businessManagement.js'
import type { MutationPrincipal } from './mutationKernel.js'
import { assertBusinessManagementGrant, type BusinessManagementGrant } from './businessManagementAccess.js'
import type { createAuthoritativeCommandExecutor } from './authoritativeCommands.js'
import type { WorkspaceSource } from './workspaceSource.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const commandId = z.string().trim().min(8).max(160)
export const getBusinessManagementSchema = z.object({ query: businessManagementReadSchema.optional() }).strict()
export const executeBusinessManagementSchema = z.object({ commandId, baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), change: businessManagementSchema }).strict()
export const undoBusinessManagementSchema = z.object({ commandId, targetCommandId: commandId }).strict()
export type BusinessManagementToolName = 'get_business_management' | 'execute_business_management' | 'undo_business_management'
export interface BusinessManagementTools {
  invoke(name: BusinessManagementToolName, input: unknown): Promise<CallToolResult>
}
const result = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data })

/** Principal and dependencies are server-owned closures, never MCP arguments. */
export function createBusinessManagementTools(options: {
  principal: MutationPrincipal
  source: WorkspaceSource
  createExecutor: (admitted: BusinessManagementGrant) => ReturnType<typeof createAuthoritativeCommandExecutor>
  resolveGrant: (principal: MutationPrincipal) => Promise<BusinessManagementGrant | undefined>
}): BusinessManagementTools {
  const principal = Object.freeze({ ...options.principal })
  async function authorize() {
    const grant = await options.resolveGrant(principal)
    assertBusinessManagementGrant(principal, grant)
    return Object.freeze({ ...grant })
  }
  return {
    async invoke(name, input) {
      try {
        if (name === 'get_business_management') {
          const parsed = getBusinessManagementSchema.parse(input)
          const grant = await options.resolveGrant(principal)
          if (!grant) return result({ authorized: false, consentVersion: 2, capability: 'workspace.manage', reason: 'EXPLICIT_CONSENT_REQUIRED' })
          assertBusinessManagementGrant(principal, grant)
          const admitted = Object.freeze({ ...grant })
          const current = await options.source.read()
          if (current.context.workspaceOwnerUserId !== principal.userId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Management workspace owner does not match the current account.', false)
          const fresh = await authorize()
          if (fresh.id !== admitted.id || fresh.revision !== admitted.revision) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Management authorization changed during the read. Start a new request.', false)
          return result({ authorized: true, consentVersion: 2, capability: 'workspace.manage', workspaceVersion: current.context.workspaceVersion,
            domains: ['independent_prep', 'independent_manual_action', 'application_group'],
            permanentDeletion: false, externalEffects: false,
            ...(parsed.query ? { data: readBusinessManagement(current.snapshot, parsed.query) } : {}) })
        }
        // The executor independently binds/rechecks grant proof and uses atomic SQL.
        // This precheck also protects lookup/idempotent-return paths of undo.
        const admitted = await authorize()
      assertNoScoringInput(input)
        const executor = options.createExecutor(admitted)
        let executed
        let submittedCommandId: string
        if (name === 'execute_business_management') {
          const parsed = executeBusinessManagementSchema.parse(input)
          submittedCommandId = parsed.commandId
          executed = await executor.execute(principal, { commandId: parsed.commandId, baseRevision: parsed.baseRevision, command: { type: 'business_management', value: parsed.change } })
        } else if (name === 'undo_business_management') {
          const parsed = undoBusinessManagementSchema.parse(input)
          submittedCommandId = parsed.commandId
          const target = await executor.lookup(principal, parsed.targetCommandId, true)
          if (!target.found || target.operation !== 'business_management') throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Undo must target a management command in the current account.', false)
          executed = await executor.undo(principal, parsed)
        } else throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Unknown management tool.', false)
        if (executed.outcome !== 'COMMITTED') {
          // These paths can await reads without reaching atomic commit. Withhold
          // stale results after revoke/regrant, without claiming a past write was undone.
          const fresh = await authorize()
          if (fresh.id !== admitted.id || fresh.revision !== admitted.revision) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Management authorization changed; result details are withheld. Previously committed changes are not rolled back.', false)
        }
        // Do not return the entire workspace or stored compensation through MCP.
        return result({ outcome: executed.outcome, workspaceVersion: `txn:${executed.revision}`, commandId: submittedCommandId, result: executed.result, conflict: executed.conflict })
      } catch (caught) {
        const data = caught instanceof WorkspaceSourceError || caught instanceof ScoringRetiredError
          ? { code: caught.code, message: caught.message, retryable: caught.retryable }
          : caught instanceof z.ZodError
            ? { code: 'INVALID_ARGUMENT', message: 'Management arguments do not match the supported bounded command schema.', retryable: false }
            : { code: 'MANAGEMENT_FAILED', message: 'Management request failed without a confirmed result. Read current state before retrying the same command ID.', retryable: false }
        return { ...result(data), isError: true }
      }
    },
  }
}
