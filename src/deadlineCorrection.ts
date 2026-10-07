import { canonicalOpportunityId } from './opportunityCanonicalization.js'
import { validSourceDeadline, validSourceInstant } from './sourceCalendar.js'
import { cancelReminderIntentInPlace } from './reminders.js'
import type { ApplicationDeadlineCorrection } from './applicationDeadline.js'
import { applicationDeadlineFingerprint, applicationDeadlineNodes, deadlineNodeFacts, correctionOwnsDeadlineNode, hasApplicationEvidence, resolveApplicationDeadline } from './applicationDeadline.js'
import type { PJSDASSnapshot } from './snapshot.js'

export interface CorrectApplicationDeadlineCommand {
  commandId: string
  kind: 'correct_application_deadline'
  opportunityId: string
  expectedDeadlineFingerprint: string
  correction: Pick<ApplicationDeadlineCorrection, 'state' | 'deadline' | 'precision' | 'timezone' | 'sourceUrl' | 'sourceAuthority' | 'evidence' | 'checkedAt' | 'postingStatus'>
}

/** Bounded unsubmitted-only repair. Retains history and never creates an occurrence for an unknown date. */
export function correctApplicationDeadline(next: PJSDASSnapshot, command: CorrectApplicationDeadlineCommand, timestamp: string, original = next) {
  const target = next.data.opportunities.find(item => item.id === canonicalOpportunityId(next, command.opportunityId))
  if (!target) throw new Error('The exact Opportunity was not found.')
  if (hasApplicationEvidence(target, next.data) || !['not_applied', 'waiting_release'].includes(next.data.processes.find(item => item.opportunityId === target.id)?.stage ?? target.processStage) || !['not_applied', 'waiting_release'].includes(target.processStage) || target.participationStatus === 'abandoned') throw new Error('Deadline correction is limited to active confirmed-unsubmitted opportunities.')
  if (applicationDeadlineFingerprint(original.data.opportunities.find(item => item.id === target.id)!, original.data) !== command.expectedDeadlineFingerprint) throw new Error('Deadline owners changed since review; read them again before correcting.')
  const input = command.correction
  const url = new URL(input.sourceUrl ?? '')
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !input.evidence.trim()) throw new Error('Deadline correction requires a public evidence URL and explanation.')
  if (!validSourceInstant(input.checkedAt) || Date.parse(input.checkedAt) > Date.parse(timestamp) + 60_000) throw new Error('The source checkedAt is invalid or in the future.')
  if (input.state === 'confirmed' && (!input.deadline || !input.precision || !Number.isFinite(Date.parse(input.deadline)))) throw new Error('Confirmed deadline needs a valid date and explicit precision.')
  if (input.state === 'unknown' && (input.deadline || input.precision)) throw new Error('Unknown deadline must not carry an invented date or precision.')
  if (input.state === 'confirmed' && !validSourceDeadline(input.deadline!, input.precision!)) throw new Error('Date-only evidence must retain a real calendar date; datetime evidence requires a valid calendar, clock and explicit timezone offset.')
  if (input.timezone && !['floating-date', 'source-offset'].includes(input.timezone)) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }) } catch { throw new Error('Invalid deadline timezone.') }
  }
  const ranks = { official_role: 5, user: 5, official_campaign: 4, university_repost: 3, aggregator: 1 }
  const previousCorrection = target.detail?.deadlineCorrections?.at(-1)
  if (previousCorrection && ranks[input.sourceAuthority] < ranks[previousCorrection.sourceAuthority]) throw new Error('A lower-authority source cannot replace the existing verified deadline correction.')
  const existingExplicit = applicationDeadlineNodes(next.data, target.id).some(node => !['cancelled', 'superseded'].includes(node.state) && ['user_explicit', 'source_explicit'].includes(node.temporal.resolutionBasis) && !correctionOwnsDeadlineNode(previousCorrection, node))
  const existingUser = Boolean(target.detail?.userFacts?.deadline)
  if ((existingExplicit || existingUser) && ranks[input.sourceAuthority] < ranks.official_role) throw new Error('Weaker evidence cannot replace an existing explicit user or official deadline; review the conflicting sources.')
  const previous = resolveApplicationDeadline(target, next.data)
  const currentNodes = applicationDeadlineNodes(next.data, target.id)
  const correction: ApplicationDeadlineCorrection = { ...input, commandId: command.commandId, recordedAt: timestamp, previousDeadline: previous.deadline, previousNodeIds: currentNodes.map(item => item.id), acknowledgedNodeFacts: deadlineNodeFacts(currentNodes) }
  target.detail = { ...target.detail, deadlineCorrections: [...(target.detail?.deadlineCorrections ?? []), correction] }
  target.deadline = input.state === 'confirmed' ? input.deadline : undefined
  target.deadlinePrecision = input.state === 'confirmed' ? input.precision : undefined
  // The correction owns a job fact. Prior node bytes/versions remain archival
  // evidence, acknowledged exactly by the fact-only owner above.
  const applications = next.data.actions.filter(item => item.opportunityId === target.id && item.kind === 'apply' && ['todo', 'doing'].includes(item.status))
  for (const action of applications) {
    action.dueAt = target.deadline
    action.duePrecision = target.deadlinePrecision
    action.timingMode = target.deadline ? 'deadline' : undefined
    action.updatedAt = timestamp
  }
  // Cancel pending reminders linked only to obsolete application nodes.
  const occurrenceIds = new Set(currentNodes.map(item => item.occurrenceId))
  const nodeIds = new Set((next.data.scheduleNodes ?? []).filter(node => occurrenceIds.has(node.occurrenceId)).map(node => node.id))
  for (const reminder of next.data.reminderIntents ?? []) {
    if (nodeIds.has(reminder.scheduleNodeId) && reminder.state !== 'cancelled') cancelReminderIntentInPlace(next.data, reminder, timestamp)
  }
  correction.resultNodeIds = applicationDeadlineNodes(next.data, target.id).map(node => node.id)
  return correction
}
