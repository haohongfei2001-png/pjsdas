import { resolveApplicationDeadline } from './applicationDeadline.js'
import { z } from 'zod/v4'
import { verifiedDiscoveryObservationSchema } from './verifiedDiscoveryCommand.js'
import { applyPostingRefreshToInbox, applyPostingRefreshToOpportunity, bindVerifiedPostingRefresh, resolvePostingRefreshTarget } from './postingRefresh.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

const schema = z.object({ kind: z.literal('refresh_verified_discovery_posting'), commandId: z.string().min(1).max(500),
  operationId: z.string().min(1).max(500), ownerKind: z.enum(['opportunity', 'inbox']), ownerId: z.string().min(1).max(500),
  expectedPostingId: z.string().min(1).max(500), expectedCanonicalSourceUrl: z.string().url().max(2000),
  observation: verifiedDiscoveryObservationSchema }).strict()
export type VerifiedPostingRefreshCommand = z.infer<typeof schema>

/** Internal adapter command. The gateway verifies source ownership again before
 * applying a signed review, and the same reducer serves local reviewed writes. */
export function applyVerifiedPostingRefreshCommand(snapshot: PJSDASSnapshot, raw: VerifiedPostingRefreshCommand, now = new Date()) {
  const command = schema.parse(raw), observation = command.observation
  if (observation.sourceProof && Date.parse(observation.sourceProof.verifiedAt) > now.getTime()) throw new Error('Source verification is later than this domain command.')
  if (observation.sourceProof?.authorityEvidence && Date.parse(observation.sourceProof.authorityEvidence.expiresAt) <= now.getTime()) {
    throw new Error('DISCOVERY_VERIFICATION_REQUIRED: the source authority expired before refresh.')
  }
  const operation = bindVerifiedPostingRefresh({ id: command.operationId, kind: 'refresh_job_posting', summary: 'Verified recruiting source refresh',
    ownerKind: command.ownerKind, ownerId: command.ownerId, expectedPostingId: command.expectedPostingId,
    expectedCanonicalSourceUrl: command.expectedCanonicalSourceUrl, sourceUrl: observation.sourceUrl, sourceTitle: observation.sourceTitle,
    postingStatus: observation.postingStatus ?? 'unknown', observedAt: observation.sourceVerifiedAt ?? now.toISOString() }, observation)
  const next = upgradeSnapshotToLatest(snapshot)
  const target = resolvePostingRefreshTarget(operation, next.data.opportunities, next.data.discoveryInbox ?? [])
  if (!target) throw new Error(`Posting ${operation.expectedPostingId} changed since the signed proposal was prepared.`)
  if (target.ownerKind === 'opportunity') {
    const owner = next.data.opportunities.find(item => item.id === target.ownerId)!
    const updated = applyPostingRefreshToOpportunity(owner, operation, now)
    const effectiveDeadline = resolveApplicationDeadline(updated, next.data)
    updated.deadline = effectiveDeadline.state === 'confirmed' ? effectiveDeadline.deadline : undefined
    updated.deadlinePrecision = effectiveDeadline.state === 'confirmed' ? effectiveDeadline.precision : undefined
    next.data.opportunities = next.data.opportunities.map(item => item.id === owner.id ? updated : item)
  } else {
    const owner = next.data.discoveryInbox!.find(item => item.id === target.ownerId)!
    const updated = applyPostingRefreshToInbox(owner, operation, now)
    next.data.discoveryInbox = next.data.discoveryInbox!.map(item => item.id === owner.id ? updated : item)
  }
  next.exportedAt = now.toISOString()
  validateSnapshot(next)
  return { status: 'APPLIED' as const, snapshot: next, target, operation, summary: 'Refreshed verified recruiting facts.' }
}
