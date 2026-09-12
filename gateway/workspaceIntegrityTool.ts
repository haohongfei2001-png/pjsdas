import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { auditWorkspaceIntegrity } from '../src/workspaceIntegrity.js'
import { WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

export const getWorkspaceIntegritySchema = z.object({})

function success(output: object): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: { ...output } }
}

function failure(caught: unknown): CallToolResult {
  const code = caught instanceof WorkspaceSourceError ? caught.code : 'TEMPORARILY_UNAVAILABLE'
  const retryable = caught instanceof WorkspaceSourceError ? caught.retryable : true
  const message = caught instanceof Error ? caught.message : 'PJSDAS workspace integrity audit is unavailable.'
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, retryable }) }] }
}

export async function invokeWorkspaceIntegrity(source: WorkspaceSource): Promise<CallToolResult> {
  try {
    const { snapshot, context } = await source.read()
    const generatedAt = context.now ?? new Date()
    const integrity = auditWorkspaceIntegrity(snapshot, generatedAt)
    return success({
      meta: { workspaceVersion: context.workspaceVersion, generatedAt: generatedAt.toISOString(), source: 'pjsdas' },
      integrity,
      assurance: integrity.criticalCount > 0
        ? `${integrity.criticalCount} critical workspace integrity issue(s) require attention before trusting autonomous writes.`
        : integrity.warningCount > 0
          ? `No critical corruption found; ${integrity.warningCount} warning(s) should be reviewed. The audit did not modify data.`
          : 'No structural integrity issue was detected by the current read-only audit. The audit did not modify data.',
    })
  } catch (caught) {
    return failure(caught)
  }
}
