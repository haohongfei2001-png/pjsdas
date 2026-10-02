import * as z from 'zod/v4'
import { applyUserDomainCommand } from './domainCommands.js'
import { resolveApplicationDeadline } from './applicationDeadline.js'
import type { PJSDASSnapshot } from './snapshot.js'

const id = z.string().trim().min(1).max(240)
const instant = z.string().max(80).refine(value => Number.isFinite(Date.parse(value)), 'Invalid date/time')
const publicUrl = z.string().url().max(2000).refine(value => { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password }, 'Expected a public evidence URL')
const commandId = z.string().trim().min(8).max(160)
const deadlineCommand = z.object({
  commandId, kind: z.literal('correct_application_deadline'), opportunityId: id,
  expectedDeadlineFingerprint: z.string().min(1).max(64_000),
  correction: z.object({ state: z.enum(['confirmed', 'unknown']), deadline: instant.optional(), precision: z.enum(['date', 'datetime']).optional(),
    sourceUrl: publicUrl, sourceAuthority: z.enum(['official_role', 'official_campaign', 'university_repost', 'aggregator', 'user']),
    evidence: z.string().trim().min(1).max(1600), checkedAt: instant, postingStatus: z.enum(['open', 'closed', 'unknown']) }).strict(),
}).strict()
const eventCommand = z.object({ commandId, kind: z.literal('invalidate_process_event'), opportunityId: id, eventId: id, receiptId: id,
  expectedEventUpdatedAt: instant, reason: z.string().trim().min(1).max(800), evidenceRefs: z.array(z.string().trim().min(1).max(1000)).min(1).max(20) }).strict()
const exclusion = z.object({ opportunityId: id, reason: z.string().trim().min(1).max(1600) }).strict()
export const correctionReviewPacketSchema = z.object({
  schema: z.literal('todayaction-correction-review-v1'), accountId: id, reviewedAt: instant,
  workspaceVersion: z.string().regex(/^txn:\d+$/),
  excluded: z.array(exclusion).max(500), held: z.array(exclusion).max(500),
  entries: z.array(z.object({ company: z.string().trim().min(1).max(300), role: z.string().trim().min(1).max(500),
    reviewStatus: z.enum(['ready', 'needs_review']), command: z.discriminatedUnion('kind', [deadlineCommand, eventCommand]) }).strict()).min(1).max(100),
}).strict().superRefine((packet, ctx) => {
  const blocked = new Set([...packet.excluded, ...packet.held].map(item => item.opportunityId))
  const commands = new Set<string>(), targets = new Set<string>()
  packet.entries.forEach((entry, index) => {
    const command = entry.command
    if (blocked.has(command.opportunityId) || commands.has(command.commandId) || targets.has(command.opportunityId)) ctx.addIssue({ code: 'custom', path: ['entries', index], message: 'Excluded, held or duplicate target/command: no part of this packet can be applied.' })
    commands.add(command.commandId); targets.add(command.opportunityId)
    if (command.kind === 'correct_application_deadline') {
      const correction = command.correction
      if (correction.state === 'unknown' ? correction.deadline !== undefined || correction.precision !== undefined : !correction.deadline || !correction.precision) ctx.addIssue({ code: 'custom', path: ['entries', index], message: 'Unknown deadline must omit date and precision; confirmed deadline requires both.' })
      if (correction.precision === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(correction.deadline ?? '') || new Date(correction.deadline!).toISOString().slice(0, 10) !== correction.deadline)) ctx.addIssue({ code: 'custom', path: ['entries', index], message: 'Date-only evidence cannot invent a clock time.' })
    }
  })
})
export type CorrectionReviewPacket = z.infer<typeof correctionReviewPacketSchema>
export type CorrectionReviewEntry = CorrectionReviewPacket['entries'][number]
export function parseCorrectionReviewPacket(text: string) {
  if (new TextEncoder().encode(text).byteLength > 2_000_000) throw new Error('Review file exceeds 2 MB; nothing was imported.')
  try { return correctionReviewPacketSchema.parse(JSON.parse(text)) }
  catch (error) { throw new Error('Invalid review file; no records imported. ' + (error instanceof z.ZodError ? error.issues[0]?.message : 'Expected complete JSON.')) }
}
export function prepareRecordCorrection(packet: CorrectionReviewPacket, entry: CorrectionReviewEntry, snapshot: PJSDASSnapshot, accountId: string, now = new Date()) {
  if (packet.accountId !== accountId) throw new Error('Review file belongs to another account; nothing was sent.')
  if (!packet.entries.includes(entry) || entry.reviewStatus !== 'ready' || [...packet.excluded, ...packet.held].some(item => item.opportunityId === entry.command.opportunityId)) throw new Error('This record requires fresh evidence review; correction is blocked.')
  const opportunity = snapshot.data.opportunities.find(item => item.id === entry.command.opportunityId)
  if (!opportunity || opportunity.company !== entry.company || opportunity.role !== entry.role) throw new Error('Exact company/role identity changed; review the source again.')
  if (Date.parse(packet.reviewedAt) > now.getTime() + 60_000) throw new Error('Review time is in the future.')
  // Pure dry-run uses the same ownership/protection reducer as the authoritative write.
  // Never replace the reviewed token with the currently observed token.
  const result = applyUserDomainCommand(snapshot, entry.command, now)
  if (result.status !== 'APPLIED') throw new Error('This command is not a new applicable correction; inspect its existing receipt/history.')
  const command = entry.command
  return { company: opportunity.company, role: opportunity.role, previousDeadline: resolveApplicationDeadline(opportunity, snapshot.data),
    previousStage: opportunity.currentStageLabel, event: command.kind === 'invalidate_process_event' ? snapshot.data.processEvents.find(item => item.id === command.eventId) : undefined }
}
