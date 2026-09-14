import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { expectedSourcesFromRegistry, summarizeCoverage } from '../src/ingestion.js'
import { summarizeSourceHealth } from '../src/sourceHealth.js'
import { WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

export const getCoverageStatusSchema = z.object({})

function success(output: object): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: { ...output } }
}

function failure(caught: unknown): CallToolResult {
  const code = caught instanceof WorkspaceSourceError ? caught.code : 'TEMPORARILY_UNAVAILABLE'
  const retryable = caught instanceof WorkspaceSourceError ? caught.retryable : true
  const message = caught instanceof Error ? caught.message : 'PJSDAS coverage status is unavailable.'
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, retryable }) }] }
}

export async function invokeCoverageStatus(source: WorkspaceSource): Promise<CallToolResult> {
  try {
    const { snapshot, context } = await source.read()
    const generatedAt = context.now ?? new Date()
    const expectedSources = expectedSourcesFromRegistry(snapshot.data.timeline)
    const coverage = summarizeCoverage(snapshot.data.timeline, { now: generatedAt, expectedSources })
    const sourceHealth = summarizeSourceHealth(snapshot.data.timeline, generatedAt)
    return success({
      meta: { workspaceVersion: context.workspaceVersion, generatedAt: generatedAt.toISOString(), source: 'pjsdas' },
      coverage,
      sourceHealth,
      assurance: coverage.allCaughtUp
        ? `All ${coverage.expectedSourceCount} enabled ingestion sources have completed within their registry SLA; each latest run is balanced and no enabled source record remains unresolved.`
        : coverage.missingSourceCount > 0
          ? `${coverage.missingSourceCount} enabled ingestion source(s) have no completed durable run yet.`
          : coverage.staleSourceCount > 0
            ? `${coverage.staleSourceCount} enabled ingestion source(s) are outside their freshness SLA; Coverage is not green even if their last run was balanced.`
            : coverage.unresolvedCount > 0
              ? `${coverage.unresolvedCount} enabled-source record(s) are explicitly unresolved; none are silently dropped.`
              : 'At least one enabled source latest run is not balanced; inspect source summaries before relying on coverage.',
    })
  } catch (caught) {
    return failure(caught)
  }
}
