import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { summarizeCoverage } from '../src/ingestion.js'
import { WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

export const getCoverageStatusSchema = z.object({})

function success(output: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    structuredContent: { ...output },
  }
}

function failure(caught: unknown): CallToolResult {
  const code = caught instanceof WorkspaceSourceError ? caught.code : 'TEMPORARILY_UNAVAILABLE'
  const retryable = caught instanceof WorkspaceSourceError ? caught.retryable : true
  const message = caught instanceof Error ? caught.message : 'PJSDAS coverage status is unavailable.'
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message, retryable }) }],
  }
}

export async function invokeCoverageStatus(source: WorkspaceSource): Promise<CallToolResult> {
  try {
    const { snapshot, context } = await source.read()
    const coverage = summarizeCoverage(snapshot.data.timeline)
    return success({
      meta: {
        workspaceVersion: context.workspaceVersion,
        generatedAt: (context.now ?? new Date()).toISOString(),
        source: 'pjsdas',
      },
      coverage,
      assurance: coverage.allCaughtUp
        ? 'Every input in each source latest completed ingestion run is accounted for and there are no unresolved source records.'
        : coverage.sourceCount === 0
          ? 'No autonomous ingestion source has completed a durable run yet.'
          : coverage.unresolvedCount > 0
            ? `${coverage.unresolvedCount} source record(s) are explicitly unresolved; none are silently dropped.`
            : 'At least one source latest run is not balanced; inspect source summaries before relying on coverage.',
    })
  } catch (caught) {
    return failure(caught)
  }
}
