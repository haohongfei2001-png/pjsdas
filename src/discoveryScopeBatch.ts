import { z } from 'zod/v4'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
/** Server-owned ledger metadata. This is not an external command or an editable
 * snapshot cursor. A claim never asserts that retrieval happened. */
export const discoveryScopeBatchSchema = z.object({
  version: z.literal(1), planFingerprint: hash, cycleId: hash,
  claimAttemptId: z.string().uuid(),
  index: z.number().int().min(0).max(79), count: z.number().int().min(1).max(80),
  queryStart: z.number().int().min(0).max(3719), queryCount: z.number().int().min(1).max(48),
  totalQueryCount: z.number().int().min(1).max(3720),
  phase: z.enum(['claimed', 'settled']),
  outcome: z.enum(['complete', 'partial', 'failed', 'budget_exhausted']).optional(),
  successfulQueryCount: z.number().int().min(0).max(48).optional(),
  failedQueryCount: z.number().int().min(0).max(48).optional(),
  omittedHitCount: z.number().int().min(0).max(1200).optional(),
  errorCode: z.string().min(1).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (value.index >= value.count || value.queryStart + value.queryCount > value.totalQueryCount) context.addIssue({ code: 'custom', message: 'Invalid batch coverage.' })
  if (value.phase === 'claimed') {
    if (['outcome', 'successfulQueryCount', 'failedQueryCount', 'omittedHitCount', 'errorCode'].some(key => Object.hasOwn(value, key))) context.addIssue({ code: 'custom', message: 'A claim cannot assert a search outcome.' })
  } else if (value.outcome === undefined || value.successfulQueryCount === undefined || value.failedQueryCount === undefined
    || value.successfulQueryCount + value.failedQueryCount !== value.queryCount
    || value.outcome === 'complete' && (value.failedQueryCount > 0 || (value.omittedHitCount ?? 0) > 0 || value.errorCode)
    || ['failed', 'budget_exhausted'].includes(value.outcome) && !value.errorCode) {
    context.addIssue({ code: 'custom', message: 'Settled progress requires exact query accounting.' })
  }
})
export type DiscoveryScopeBatch = z.infer<typeof discoveryScopeBatchSchema>

export interface DiscoveryScopeLedgerRecord {
  commandId: string; operation: string; payloadHash: string; resultingRevision: number
  receipt: Record<string, unknown>; runId: string; createdAt: string; batch: DiscoveryScopeBatch
}
