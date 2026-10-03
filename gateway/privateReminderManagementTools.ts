import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { privateReminderManagementSchema, readPrivateReminderManagement, privateReminderManagementReadSchema, PrivateReminderManagementError } from '../src/privateReminderManagement.js'
import type { MutationPrincipal } from './mutationKernel.js'
import { assertPrivateReminderManagementGrant, type PrivateReminderManagementGrant } from './privateReminderManagementAccess.js'
import { createAuthoritativeCommandExecutor } from './authoritativeCommands.js'
import { createTransactionalWorkspaceStore, type TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const commandId = z.string().trim().min(8).max(160)
export const getPrivateReminderManagementSchema = privateReminderManagementReadSchema
export const executePrivateReminderManagementSchema = z.object({ commandId, baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), change: privateReminderManagementSchema }).strict()
export const restorePrivateReminderManagementSchema = z.object({ commandId, targetCommandId: commandId, expectedCompensationFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type PrivateReminderManagementToolName = 'get_private_reminder_management' | 'execute_private_reminder_management' | 'restore_private_reminder_management'
const result = (data: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data })

/** Source-only adapter: no production runtime, tool catalog or consent handler registers it. */
export function createPrivateReminderManagementTools(options: {
  principal: MutationPrincipal
  storeOptions: TransactionalWorkspaceStoreOptions
  resolveGrant: (principal: MutationPrincipal) => Promise<PrivateReminderManagementGrant | undefined>
}) {
  const principal = Object.freeze({ ...options.principal })
  const store = createTransactionalWorkspaceStore(options.storeOptions)
  async function authorize(admitted?: PrivateReminderManagementGrant) {
    const grant = await options.resolveGrant(principal)
    assertPrivateReminderManagementGrant(principal, grant)
    if (admitted && (grant.id !== admitted.id || grant.revision !== admitted.revision)) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Private-reminder authorization changed. Start a new explicit request.', false)
    return Object.freeze({ ...grant })
  }
  return { async invoke(name: PrivateReminderManagementToolName, input: unknown): Promise<CallToolResult> {
    try {
      const admitted = await authorize()
      if (name === 'get_private_reminder_management') {
        const parsedRead = getPrivateReminderManagementSchema.parse(input)
        const current = await store.readForUser(principal.userId, { preserveRawData: true })
        if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'TodayAction workspace is unavailable.', false)
        if (current.userId !== principal.userId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Workspace owner does not match the current account.', false)
        const data = await readPrivateReminderManagement(current.snapshot, parsedRead)
        await authorize(admitted)
        return result({ authorized: true, consentVersion: 6, capability: 'workspace.reminders.manage', workspaceVersion: `txn:${current.revision}`, data })
      }
      // Bind admission inside the adapter rather than relying on future runtime wiring.
      const executor = createAuthoritativeCommandExecutor({ ...options.storeOptions, resolvePrivateReminderManagementGrant: async () => authorize(admitted) })
      let executed
      let submittedCommandId: string
      if (name === 'execute_private_reminder_management') {
        const parsed = executePrivateReminderManagementSchema.parse(input)
        submittedCommandId = parsed.commandId
        executed = await executor.execute(principal, { commandId: parsed.commandId, baseRevision: parsed.baseRevision, command: { type: 'private_reminder_management', value: parsed.change } })
      } else if (name === 'restore_private_reminder_management') {
        const parsed = restorePrivateReminderManagementSchema.parse(input)
        submittedCommandId = parsed.commandId
        const target = await executor.lookup(principal, parsed.targetCommandId, true)
        if (!target.found || target.operation !== 'private_reminder_management') throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Restore must target a private-reminder-management command in the current account.', false)
        executed = await executor.undo(principal, parsed)
      } else throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Unknown private-reminder-management tool.', false)
      if (executed.outcome !== 'COMMITTED') await authorize(admitted)
      return result({ outcome: executed.outcome, workspaceVersion: `txn:${executed.revision}`, commandId: submittedCommandId, result: executed.result, conflict: executed.conflict })
    } catch (error) {
      const data = error instanceof WorkspaceSourceError || error instanceof PrivateReminderManagementError ? { code: error.code, message: error.message, retryable: error instanceof WorkspaceSourceError ? error.retryable : false }
        : error instanceof z.ZodError ? { code: 'INVALID_ARGUMENT', message: 'Arguments do not match the bounded private-reminder-management schema.', retryable: false }
          : { code: 'MANAGEMENT_FAILED', message: 'No result was confirmed. Read current state before retrying the same command ID.', retryable: false }
      return { ...result(data), isError: true }
    }
  } }
}
