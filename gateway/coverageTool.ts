import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import {
  PJSDAS_EXPECTED_INGESTION_SOURCES,
  summarizeCoverage,
} from '../src/ingestion.js'
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
    const generatedAt = context.now ?? new Date()
    const coverage = summarizeCoverage(snapshot.data.timeline, {
      now: generatedAt,
      expectedSources: PJSDAS_EXPECTED_INGESTION_SOURCES,
    })
    return success({
      meta: {
        workspaceVersion: context.workspaceVersion,
        generatedAt: generatedAt.toISOString(),
        source: 'pjsdas',
      },
      coverage,
      assurance: coverage.allCaughtUp
        ? 'All configured ingestion sources have completed within their SLA; each latest run is balanced and no source record remains unresolved.'
        : coverage.missingSourceCount > 0
          ? `${coverage.missingSourceCount} configured ingestion source(s) have no completed durable run yet.`
          : coverage.staleSourceCount > 0
            ? `${coverage.staleSourceCount} configured ingestion source(s) are outside their freshness SLA; Coverage is not green even if their last run was balanced.`
            : coverage.unresolvedCount > 0
              ? `${coverage.unresolvedCount} source record(s) are explicitly unresolved; none are silently dropped.`
              : 'At least one latest source run is not balanced; inspect source summaries before relying on coverage.',
    })
  } catch (caught) {
    return failure(caught)
  }
}
