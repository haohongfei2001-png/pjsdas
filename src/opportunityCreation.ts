import type { DatePrecision, Opportunity } from './model.js'
import type { SnapshotData } from './snapshot.js'
import { canonicalizeJobSourceUrl } from './jobPosting.js'
import { stableIngestionHash } from './ingestion.js'
import { validSourceDeadline } from './sourceCalendar.js'
import { assertNoNewOpportunityRating } from './scoringRetirement.js'

export interface UserJobFacts {
  company: string
  role: string
  sourceUrl?: string
  sourceTitle?: string
  location?: string
  deadline?: string
  deadlinePrecision?: DatePrecision
  compensationText?: string
}
const text = (value: string) => value.trim().replace(/\s+/g, ' ')
const identityText = (value?: string) => text(value ?? '').toLocaleLowerCase()
export function normalizedUserJobFacts(input: UserJobFacts): UserJobFacts {
  const facts: UserJobFacts = { company: text(input.company), role: text(input.role) }
  if (!facts.company || facts.company.length > 120 || !facts.role || facts.role.length > 180) throw new Error('Company and job title are required and must fit the supported length.')
  for (const key of ['sourceTitle', 'location', 'compensationText'] as const) {
    const value = input[key]?.trim()
    if (value && value.length > (key === 'compensationText' ? 500 : 240)) throw new Error('Job fact exceeds its bounded length.')
    if (value) facts[key] = value
  }
  if (input.sourceUrl?.trim()) {
    const url = new URL(input.sourceUrl.trim())
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || input.sourceUrl.length > 2000) throw new Error('Source link must be an HTTP(S) reference without credentials.')
    facts.sourceUrl = canonicalizeJobSourceUrl(url.href)
  }
  if (input.deadline) {
    const precision = input.deadlinePrecision ?? (/^\d{4}-\d{2}-\d{2}$/.test(input.deadline) ? 'date' : 'datetime')
    if (!validSourceDeadline(input.deadline, precision)) throw new Error('Deadline requires a real date or an offset-aware time.')
    facts.deadline = input.deadline
    facts.deadlinePrecision = precision
  } else if (input.deadlinePrecision) throw new Error('Deadline precision requires a deadline.')
  return facts
}
export function userJobIdentity(facts: UserJobFacts) {
  return JSON.stringify([identityText(facts.company), identityText(facts.role), identityText(facts.location), facts.sourceUrl ?? ''])
}
export function findUserJobDuplicate(facts: UserJobFacts, opportunities: Opportunity[]) {
  const sameTitle = opportunities.filter(item => identityText(item.company) === identityText(facts.company)
    && identityText(item.role) === identityText(facts.role))
  const matches = sameTitle.filter(item => {
    const user = item.detail?.userFacts
    const sourceUrl = user?.applicationUrl ?? item.detail?.discovery?.sourceUrl
    if (!facts.sourceUrl && !user?.creationCommandId) return false
    return userJobIdentity({ company: item.company, role: item.role, location: user?.location ?? item.detail?.discovery?.location,
      sourceUrl: sourceUrl ? canonicalizeJobSourceUrl(sourceUrl) : undefined }) === userJobIdentity(facts)
  })
  const ambiguous = sameTitle.some(item => {
    if (matches.includes(item)) return false
    const location = item.detail?.userFacts?.location ?? item.detail?.discovery?.location
    const url = item.detail?.userFacts?.applicationUrl ?? item.detail?.discovery?.sourceUrl
    const sameUrl = Boolean(facts.sourceUrl && url && canonicalizeJobSourceUrl(url) === facts.sourceUrl)
    return sameUrl && (!facts.location || !location) || (!facts.sourceUrl || !url) && (!facts.location || !location || identityText(facts.location) === identityText(location))
  })
  if (!matches.length && ambiguous) throw new Error('An existing job may match; clarify its exact source/location before creating another identity.')

  if (matches.length > 1) throw new Error('Several saved jobs have this exact identity; clarify the intended job before adding.')
  return matches[0]
}
export function createUserOpportunity(input: UserJobFacts, commandId: string, timestamp: string): Opportunity {
  const facts = normalizedUserJobFacts(input)
  return {
    id: `user-opportunity:${stableIngestionHash(commandId)}`, company: facts.company, role: facts.role,
    currentStageLabel: '未投递', processStage: 'not_applied', participationStatus: 'active',
    early: false, deadline: facts.deadline, deadlinePrecision: facts.deadlinePrecision,
    opportunityValue: 0, fitScore: 0, locallyManaged: true, importedAt: timestamp,
    detail: { userFacts: { provenance: 'user_asserted', creationCommandId: commandId, updatedAt: timestamp,
      applicationUrl: facts.sourceUrl, location: facts.location, compensationText: facts.compensationText,
      deadline: facts.deadline, deadlinePrecision: facts.deadlinePrecision } },
  }
}

/** Shared additive domain guard. Saving a job never creates personal intent. */
export function appendOpportunityOnly(data: Pick<SnapshotData, 'opportunities' | 'opportunityAliases'>, opportunity: Opportunity) {
  assertNoNewOpportunityRating(opportunity)
  if (!opportunity.id.trim() || !opportunity.company.trim() || !opportunity.role.trim()
    || !['not_applied', 'waiting_release'].includes(opportunity.processStage)) throw new Error('Job creation requires an unsubmitted job identity.')
  if (data.opportunities.some(item => item.id === opportunity.id)
    || data.opportunityAliases?.some(item => item.id === opportunity.id)) throw new Error('An existing or aliased job cannot be recreated.')
  const { roleType: _legacyRole, nextActionLabel: _implicitIntent, ...facts } = opportunity
  data.opportunities.push(facts)
  return facts
}
