import { z } from 'zod/v4'
import type { IngestionRunSummary } from './model.js'

export const discoveryWebQuerySchema = z.object({
  query: z.string().trim().min(1).max(4000),
  coverage: z.enum(['general_web', 'recruiting_platforms', 'employer_sites', 'university_publishers']),
  domains: z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).min(1).max(12).optional(),
}).strict().refine(value => value.coverage !== 'general_web' || !value.domains, 'General-web search must not have a closed domain filter.')

/** Trusted execution metadata, never accepted from a candidate/model payload. */
export const discoverySearchExecutionSchema = z.object({
  version: z.literal(1), provider: z.string().min(1).max(120),
  requestId: z.string().min(1).max(160), query: discoveryWebQuerySchema,
  startedAt: z.string().datetime({ offset: true }), completedAt: z.string().datetime({ offset: true }),
  outcome: z.enum(['success', 'empty', 'failed']), requestedMaxResults: z.number().int().min(1).max(25).optional(),
  providerRequestId: z.string().min(1).max(240).optional(),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  resultCount: z.number().int().min(0).max(25), errorCode: z.string().min(1).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) context.addIssue({ code: 'custom', message: 'Search completion precedes its request.' })
  if (value.requestedMaxResults !== undefined && value.resultCount > value.requestedMaxResults) context.addIssue({ code: 'custom', message: 'Returned result count exceeds the recorded request bound.' })
  if (value.outcome === 'failed') {
    if (!value.errorCode || value.resultCount !== 0) context.addIssue({ code: 'custom', message: 'Failed retrieval cannot claim returned results.' })
  } else if (!value.providerRequestId || !value.responseSha256 || value.errorCode
    || (value.outcome === 'empty') !== (value.resultCount === 0)) {
    context.addIssue({ code: 'custom', message: 'Successful retrieval requires actual provider response evidence and matching counts.' })
  }
})
export type DiscoverySearchExecution = z.infer<typeof discoverySearchExecutionSchema>

/** A balanced ingestion ledger is not evidence that public-web retrieval ran.
 * Historical records stay intact; absent execution proof is displayed unknown. */
export function discoveryRunRetrievalState(run: IngestionRunSummary): 'complete' | 'partial' | 'unverified' | undefined {
  if(run.sourceKind!=='gpt_monitor')return undefined
  const parsed=z.array(discoverySearchExecutionSchema).min(1).max(48).safeParse(run.searchExecutions)
  if(!parsed.success)return 'unverified'
  if (run.omittedSearchHitCount !== undefined && (!Number.isInteger(run.omittedSearchHitCount) || run.omittedSearchHitCount < 0 || run.omittedSearchHitCount > 1200)) return 'unverified'
  return parsed.data.some(item=>item.outcome==='failed')||run.retrievalStatus==='partial'||(run.omittedSearchHitCount ?? 0)>0 ? 'partial':'complete'
}
