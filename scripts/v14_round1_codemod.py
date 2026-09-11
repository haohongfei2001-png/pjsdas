from pathlib import Path
import textwrap

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(textwrap.dedent(content).lstrip(), encoding='utf-8')


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding='utf-8')
    count = text.count(old)
    if count < 1:
        raise RuntimeError(f'{path}: expected exactly one replacement target, found {count}: {old[:140]!r}')
    target.write_text(text.replace(old, new, 1), encoding='utf-8')


# 1) Discovery Inbox domain model.
replace_once(
    'src/model.ts',
    "  | 'other'\n\nexport type TimelineCategory",
    "  | 'other'\n\n"
    "export type DiscoveryInboxStatus = 'new' | 'seen' | 'later' | 'dismissed' | 'promoted'\n\n"
    "export interface DiscoveryInboxItem {\n"
    "  id: string\n"
    "  candidateOpportunityId: string\n"
    "  company: string\n"
    "  role: string\n"
    "  roleType: OpportunityRole\n"
    "  sourceUrl: string\n"
    "  sourceTitle: string\n"
    "  location?: string\n"
    "  deadline?: string\n"
    "  compensationText?: string\n"
    "  rationale: string\n"
    "  opportunityValue: number\n"
    "  fitScore: number\n"
    "  fitConfidence: DiscoveryConfidence\n"
    "  opportunityValueConfidence: DiscoveryConfidence\n"
    "  profileWarnings?: string[]\n"
    "  status: DiscoveryInboxStatus\n"
    "  rejectionReason?: DiscoveryRejectionReason\n"
    "  sourceChangeSetId?: string\n"
    "  sourceOperationId?: string\n"
    "  discoveredAt: string\n"
    "  createdAt: string\n"
    "  updatedAt: string\n"
    "  seenAt?: string\n"
    "  promotedOpportunityId?: string\n"
    "}\n\n"
    "export type TimelineCategory",
)

write('src/discoveryInbox.ts', r'''
import { assertChangeSetValid, type ChangeSetRecord } from './changeSet.js'
import type {
  DiscoveryInboxItem,
  DiscoveryRejectionReason,
  Opportunity,
  TimelineRecord,
} from './model.js'

type DiscoveryOperation = Extract<ChangeSetRecord['operations'][number], { kind: 'add_discovered_opportunity' }>

function compact(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}

export function discoveryInboxIdentity(company: string, role: string) {
  return `${compact(company)}|${compact(role)}`
}

function changeSetId(now: Date) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase().padEnd(5, '0')
  return `CS-INBOX-${stamp}-${suffix}`
}

export function validateDiscoveryInboxItem(item: DiscoveryInboxItem): string[] {
  const errors: string[] = []
  const statuses = new Set(['new', 'seen', 'later', 'dismissed', 'promoted'])
  const roleTypes = new Set(['core', 'backup', 'reach', 'lottery', 'practice'])
  const confidences = new Set(['high', 'medium', 'low'])
  if (!item.id?.trim()) errors.push('发现箱条目缺少 ID。')
  if (!item.candidateOpportunityId?.trim()) errors.push('发现箱条目缺少候选岗位 ID。')
  if (!item.company?.trim() || !item.role?.trim()) errors.push('发现箱条目缺少公司或岗位。')
  if (!roleTypes.has(item.roleType)) errors.push('发现箱岗位类型无效。')
  if (!statuses.has(item.status)) errors.push('发现箱状态无效。')
  if (!item.sourceUrl?.startsWith('http://') && !item.sourceUrl?.startsWith('https://')) errors.push('发现箱来源 URL 无效。')
  if (!item.sourceTitle?.trim() || !item.rationale?.trim()) errors.push('发现箱来源证据不完整。')
  if (!Number.isFinite(item.opportunityValue) || item.opportunityValue < 0 || item.opportunityValue > 100) errors.push('发现箱机会价值无效。')
  if (!Number.isFinite(item.fitScore) || item.fitScore < 0 || item.fitScore > 100) errors.push('发现箱匹配度无效。')
  if (!confidences.has(item.fitConfidence) || !confidences.has(item.opportunityValueConfidence)) errors.push('发现箱置信度无效。')
  for (const [label, value] of [['discoveredAt', item.discoveredAt], ['createdAt', item.createdAt], ['updatedAt', item.updatedAt]] as const) {
    if (Number.isNaN(new Date(value).getTime())) errors.push(`发现箱 ${label} 无效。`)
  }
  if (item.deadline && Number.isNaN(new Date(item.deadline).getTime())) errors.push('发现箱截止时间无效。')
  if (item.seenAt && Number.isNaN(new Date(item.seenAt).getTime())) errors.push('发现箱 seenAt 无效。')
  return errors
}

function fromOperation(operation: DiscoveryOperation, changeSet: ChangeSetRecord, now: Date): DiscoveryInboxItem {
  const opportunity = operation.opportunity
  const evidence = opportunity.detail?.discovery
  if (!evidence) throw new Error(`发现岗位 ${opportunity.company}｜${opportunity.role} 缺少来源证据。`)
  const timestamp = now.toISOString()
  const item: DiscoveryInboxItem = {
    id: `inbox:${opportunity.id}`,
    candidateOpportunityId: opportunity.id,
    company: opportunity.company,
    role: opportunity.role,
    roleType: opportunity.roleType,
    sourceUrl: evidence.sourceUrl,
    sourceTitle: evidence.sourceTitle,
    location: evidence.location,
    deadline: opportunity.deadline,
    compensationText: evidence.compensationText,
    rationale: evidence.rationale,
    opportunityValue: opportunity.opportunityValue,
    fitScore: opportunity.fitScore,
    fitConfidence: evidence.fitConfidence,
    opportunityValueConfidence: evidence.opportunityValueConfidence,
    profileWarnings: evidence.profileWarnings ? [...evidence.profileWarnings] : undefined,
    status: 'new',
    sourceChangeSetId: changeSet.id,
    sourceOperationId: operation.id,
    discoveredAt: evidence.discoveredAt,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const errors = validateDiscoveryInboxItem(item)
  if (errors.length) throw new Error(errors[0])
  return item
}

export function discoveryInboxItemsFromChangeSet(changeSet: ChangeSetRecord, now = new Date()) {
  const operations = changeSet.operations.filter(
    (operation): operation is DiscoveryOperation => operation.kind === 'add_discovered_opportunity',
  )
  if (!operations.length || operations.length !== changeSet.operations.length) {
    throw new Error('只有独立岗位发现 ChangeSet 可以保存到发现箱。')
  }
  return operations.map((operation) => fromOperation(operation, changeSet, now))
}

export function mergeDiscoveryInboxItems(existing: DiscoveryInboxItem[], incoming: DiscoveryInboxItem[]) {
  const byIdentity = new Map(existing.map((item) => [discoveryInboxIdentity(item.company, item.role), item]))
  const result = [...existing]
  for (const candidate of incoming) {
    const key = discoveryInboxIdentity(candidate.company, candidate.role)
    const previous = byIdentity.get(key)
    if (!previous) {
      result.push(candidate)
      byIdentity.set(key, candidate)
      continue
    }
    const merged: DiscoveryInboxItem = {
      ...candidate,
      id: previous.id,
      candidateOpportunityId: previous.candidateOpportunityId || candidate.candidateOpportunityId,
      status: previous.status,
      rejectionReason: previous.rejectionReason,
      createdAt: previous.createdAt,
      seenAt: previous.seenAt,
      promotedOpportunityId: previous.promotedOpportunityId,
      updatedAt: candidate.updatedAt,
    }
    const index = result.findIndex((item) => item.id === previous.id)
    result[index] = merged
    byIdentity.set(key, merged)
  }
  return result
}

export function inboxOpportunity(item: DiscoveryInboxItem, now = new Date()): Opportunity {
  return {
    id: item.candidateOpportunityId,
    company: item.company,
    role: item.role,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: item.roleType,
    early: false,
    deadline: item.deadline,
    sourcePriority: 'AI 岗位发现 · 发现箱',
    salaryReference: item.compensationText,
    nextActionLabel: '审阅并投递',
    prepEstimateMinutes: 45,
    opportunityValue: item.opportunityValue,
    fitScore: item.fitScore,
    locallyManaged: true,
    importedAt: now.toISOString(),
    detail: {
      salaryRaw: item.compensationText,
      discovery: {
        sourceUrl: item.sourceUrl,
        sourceTitle: item.sourceTitle,
        location: item.location,
        compensationText: item.compensationText,
        rationale: item.rationale,
        discoveredAt: item.discoveredAt,
        fitConfidence: item.fitConfidence,
        opportunityValueConfidence: item.opportunityValueConfidence,
        profileWarnings: item.profileWarnings ? [...item.profileWarnings] : undefined,
      },
    },
  }
}

export function createInboxPromotionChangeSet(item: DiscoveryInboxItem, now = new Date()): ChangeSetRecord {
  const opportunity = inboxOpportunity(item, now)
  const timestamp = now.toISOString()
  const changeSet: ChangeSetRecord = {
    id: changeSetId(now),
    version: 1,
    source: 'user_action',
    status: 'pending',
    title: `发现箱加入机会池｜${item.company}｜${item.role}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    operations: [{
      id: `discovery:add:${opportunity.id}`,
      kind: 'add_discovered_opportunity',
      summary: `新增发现岗位｜${opportunity.company}｜${opportunity.role}`,
      opportunity,
    }],
  }
  assertChangeSetValid(changeSet)
  return changeSet
}

export function discoveryInboxDecisionTimeline(
  item: DiscoveryInboxItem,
  decision: 'accepted' | 'rejected',
  now = new Date(),
  reason?: DiscoveryRejectionReason,
): TimelineRecord {
  const timestamp = now.toISOString()
  return {
    id: `timeline:discovery-inbox:${item.id}:${decision}:${now.getTime()}`,
    kind: decision === 'accepted' ? 'discovery_accepted' : 'discovery_rejected',
    category: 'opportunity',
    source: 'user_action',
    occurredAt: timestamp,
    recordedAt: timestamp,
    title: decision === 'accepted' ? '从发现箱加入机会池' : '发现箱标记不感兴趣',
    detail: decision === 'accepted' ? item.rationale : reason,
    opportunityId: decision === 'accepted' ? item.candidateOpportunityId : undefined,
    company: item.company,
    role: item.role,
    sourceRef: item.sourceUrl,
    discoveryDecision: decision,
    discoveryReasonCode: decision === 'rejected' ? reason : undefined,
  }
}
''')

write('src/discoveryInboxStore.ts', r'''
import {
  applyChangeSet,
  dbPromise,
  getAllOpportunities,
  savePendingChangeSet,
} from './db.js'
import {
  createInboxPromotionChangeSet,
  discoveryInboxDecisionTimeline,
  discoveryInboxIdentity,
  discoveryInboxItemsFromChangeSet,
  mergeDiscoveryInboxItems,
} from './discoveryInbox.js'
import type { ChangeSetRecord } from './changeSet.js'
import type {
  DiscoveryInboxItem,
  DiscoveryInboxStatus,
  DiscoveryRejectionReason,
} from './model.js'

export async function getAllDiscoveryInboxItems() {
  const items = await (await dbPromise).getAll('discoveryInbox')
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.company.localeCompare(b.company))
}

export async function saveDiscoveryInboxFromChangeSet(changeSet: ChangeSetRecord) {
  const db = await dbPromise
  const existing = await db.getAll('discoveryInbox')
  const incoming = discoveryInboxItemsFromChangeSet(changeSet)
  const merged = mergeDiscoveryInboxItems(existing, incoming)
  const tx = db.transaction('discoveryInbox', 'readwrite')
  for (const item of merged) await tx.store.put(item)
  await tx.done
  return incoming.length
}

export async function updateDiscoveryInboxStatus(
  id: string,
  status: DiscoveryInboxStatus,
  rejectionReason?: DiscoveryRejectionReason,
) {
  const db = await dbPromise
  const item = await db.get('discoveryInbox', id)
  if (!item) throw new Error(`找不到发现箱条目 ${id}。`)
  if (item.status === 'promoted' && status !== 'promoted') throw new Error('已加入机会池的发现箱条目不能退回候选状态。')
  const now = new Date()
  const next: DiscoveryInboxItem = {
    ...item,
    status,
    rejectionReason: status === 'dismissed' ? (rejectionReason ?? 'not_interested') : undefined,
    seenAt: status === 'seen' ? now.toISOString() : item.seenAt,
    updatedAt: now.toISOString(),
  }
  const stores = status === 'dismissed' ? ['discoveryInbox', 'timeline'] as const : ['discoveryInbox'] as const
  const tx = db.transaction(stores, 'readwrite')
  await tx.objectStore('discoveryInbox').put(next)
  if (status === 'dismissed') {
    await tx.objectStore('timeline').put(discoveryInboxDecisionTimeline(next, 'rejected', now, next.rejectionReason))
  }
  await tx.done
  return next
}

export async function promoteDiscoveryInboxItem(id: string) {
  const db = await dbPromise
  const item = await db.get('discoveryInbox', id)
  if (!item) throw new Error(`找不到发现箱条目 ${id}。`)
  if (item.status === 'promoted') return item

  const opportunities = await getAllOpportunities()
  const existing = opportunities.find((opportunity) =>
    opportunity.id === item.candidateOpportunityId ||
    discoveryInboxIdentity(opportunity.company, opportunity.role) === discoveryInboxIdentity(item.company, item.role)
  )
  let promotedOpportunityId = existing?.id
  if (!existing) {
    const changeSet = createInboxPromotionChangeSet(item)
    await savePendingChangeSet(changeSet)
    await applyChangeSet(changeSet.id)
    promotedOpportunityId = item.candidateOpportunityId
  }

  const now = new Date()
  const promoted: DiscoveryInboxItem = {
    ...item,
    status: 'promoted',
    rejectionReason: undefined,
    promotedOpportunityId,
    updatedAt: now.toISOString(),
  }
  const tx = db.transaction(['discoveryInbox', 'timeline'], 'readwrite')
  await tx.objectStore('discoveryInbox').put(promoted)
  await tx.objectStore('timeline').put(discoveryInboxDecisionTimeline(promoted, 'accepted', now))
  await tx.done
  return promoted
}
''')

# 2) Persist Inbox in IndexedDB + snapshots/cloud sync.
replace_once(
    'src/db.ts',
    "  ImportMeta,\n  Opportunity,",
    "  ImportMeta,\n  DiscoveryInboxItem,\n  Opportunity,",
)
replace_once(
    'src/db.ts',
    "  discoveryProfiles: { key: string; value: DiscoveryProfile }\n  timeline:",
    "  discoveryProfiles: { key: string; value: DiscoveryProfile }\n"
    "  discoveryInbox: { key: string; value: DiscoveryInboxItem; indexes: { 'by-status': string; 'by-updated-at': string } }\n"
    "  timeline:",
)
replace_once(
    'src/db.ts',
    "  'discoveryProfiles',\n  'timeline',",
    "  'discoveryProfiles',\n  'discoveryInbox',\n  'timeline',",
)
replace_once('src/db.ts', "openDB<PJSDASDatabase>('pjsdas', 7,", "openDB<PJSDASDatabase>('pjsdas', 8,")
replace_once(
    'src/db.ts',
    "    if (!db.objectStoreNames.contains('timeline')) {",
    "    if (!db.objectStoreNames.contains('discoveryInbox')) {\n"
    "      const store = db.createObjectStore('discoveryInbox', { keyPath: 'id' })\n"
    "      store.createIndex('by-status', 'status')\n"
    "      store.createIndex('by-updated-at', 'updatedAt')\n"
    "    }\n"
    "    if (!db.objectStoreNames.contains('timeline')) {",
)
replace_once(
    'src/db.ts',
    "  const [opportunities, processes, processEvents, actions, prep, applicationGroups, decisionRules, discoveryProfile, timeline, changeSets, meta] =\n",
    "  const [opportunities, processes, processEvents, actions, prep, applicationGroups, decisionRules, discoveryProfile, discoveryInbox, timeline, changeSets, meta] =\n",
)
replace_once(
    'src/db.ts',
    "      db.get('discoveryProfiles', 'current'),\n      db.getAll('timeline'),",
    "      db.get('discoveryProfiles', 'current'),\n      db.getAll('discoveryInbox'),\n      db.getAll('timeline'),",
)
replace_once(
    'src/db.ts',
    "    discoveryProfile,\n    timeline,",
    "    discoveryProfile,\n    discoveryInbox,\n    timeline,",
)
replace_once(
    'src/db.ts',
    "  if (snapshot.data.discoveryProfile) await tx.objectStore('discoveryProfiles').put(snapshot.data.discoveryProfile)\n  for (const item of snapshot.data.timeline ?? [])",
    "  if (snapshot.data.discoveryProfile) await tx.objectStore('discoveryProfiles').put(snapshot.data.discoveryProfile)\n"
    "  for (const item of snapshot.data.discoveryInbox ?? []) await tx.objectStore('discoveryInbox').put(item)\n"
    "  for (const item of snapshot.data.timeline ?? [])",
)
# Same block occurs once more in restoreLocalSnapshot after first replacement, so replace again.
replace_once(
    'src/db.ts',
    "  if (snapshot.data.discoveryProfile) await tx.objectStore('discoveryProfiles').put(snapshot.data.discoveryProfile)\n  for (const item of snapshot.data.timeline ?? [])",
    "  if (snapshot.data.discoveryProfile) await tx.objectStore('discoveryProfiles').put(snapshot.data.discoveryProfile)\n"
    "  for (const item of snapshot.data.discoveryInbox ?? []) await tx.objectStore('discoveryInbox').put(item)\n"
    "  for (const item of snapshot.data.timeline ?? [])",
)

replace_once(
    'src/snapshot.ts',
    "  ApplicationGroup,\n  ImportMeta,",
    "  ApplicationGroup,\n  DiscoveryInboxItem,\n  ImportMeta,",
)
replace_once(
    'src/snapshot.ts',
    "import { validateDiscoveryProfile, type DiscoveryProfile } from './discoveryProfile.js'\n",
    "import { validateDiscoveryProfile, type DiscoveryProfile } from './discoveryProfile.js'\n"
    "import { validateDiscoveryInboxItem } from './discoveryInbox.js'\n",
)
replace_once(
    'src/snapshot.ts',
    "  discoveryProfile?: DiscoveryProfile\n  timeline?: TimelineRecord[]",
    "  discoveryProfile?: DiscoveryProfile\n  discoveryInbox?: DiscoveryInboxItem[]\n  timeline?: TimelineRecord[]",
)
replace_once(
    'src/snapshot.ts',
    "  if (data.timeline !== undefined) assertArray(data.timeline, 'timeline')",
    "  if (data.discoveryInbox !== undefined) assertArray(data.discoveryInbox, 'discoveryInbox')\n"
    "  if (data.timeline !== undefined) assertArray(data.timeline, 'timeline')",
)
replace_once(
    'src/snapshot.ts',
    "  if (data.timeline) assertUniqueIds(data.timeline, 'Timeline')",
    "  if (data.discoveryInbox) assertUniqueIds(data.discoveryInbox, 'Discovery Inbox')\n"
    "  if (data.timeline) assertUniqueIds(data.timeline, 'Timeline')",
)
replace_once(
    'src/snapshot.ts',
    "  for (const raw of data.opportunities) {",
    "  for (const raw of data.discoveryInbox ?? []) {\n"
    "    const item = raw as DiscoveryInboxItem\n"
    "    const errors = validateDiscoveryInboxItem(item)\n"
    "    if (errors.length) throw new Error(`备份损坏：发现箱条目无效（${errors[0]}）`)\n"
    "  }\n\n"
    "  for (const raw of data.opportunities) {",
)
replace_once(
    'src/cloud/workspaceFingerprint.ts',
    "    data.applicationGroups.length === 0 &&\n    (data.changeSets ?? []).length === 0 &&",
    "    data.applicationGroups.length === 0 &&\n"
    "    (data.discoveryInbox ?? []).length === 0 &&\n"
    "    (data.changeSets ?? []).length === 0 &&",
)

# 3) Quality gate + MCP discovery context understand Inbox.
replace_once(
    'src/discoveryQuality.ts',
    "import type { DiscoveryConfidence, Opportunity, OpportunityRole, TimelineRecord } from './model.js'",
    "import type { DiscoveryConfidence, DiscoveryInboxItem, Opportunity, OpportunityRole, TimelineRecord } from './model.js'",
)
replace_once(
    'src/discoveryQuality.ts',
    "  timeline: TimelineRecord[] = [],\n): DiscoveryScreeningResult<T> {",
    "  timeline: TimelineRecord[] = [],\n  inbox: DiscoveryInboxItem[] = [],\n): DiscoveryScreeningResult<T> {",
)
replace_once(
    'src/discoveryQuality.ts',
    "  for (const candidate of candidates) {\n    const latestFeedback = latestExplicitFeedbackForCandidate(timeline, candidate, now)",
    "  for (const candidate of candidates) {\n"
    "    const inboxMatch = inbox.find((item) =>\n"
    "      normalizedCompany(item.company) === normalizedCompany(candidate.company) &&\n"
    "      discoveryRoleSimilarity(item.role, candidate.role) >= 0.72\n"
    "    )\n"
    "    if (inboxMatch && inboxMatch.status !== 'promoted') {\n"
    "      const ageMs = now.getTime() - new Date(inboxMatch.updatedAt).getTime()\n"
    "      if (inboxMatch.status === 'dismissed') {\n"
    "        if (ageMs <= 120 * 24 * 60 * 60 * 1000) {\n"
    "          rejectedCandidates.push({\n"
    "            company: candidate.company,\n"
    "            role: candidate.role,\n"
    "            reasons: [`发现箱中高度相似岗位“${inboxMatch.company}｜${inboxMatch.role}”最近已被明确拒绝。`],\n"
    "          })\n"
    "          continue\n"
    "        }\n"
    "      } else {\n"
    "        skippedDuplicates.push({\n"
    "          company: candidate.company,\n"
    "          role: candidate.role,\n"
    "          reason: `高度相似岗位“${inboxMatch.company}｜${inboxMatch.role}”已经在发现箱（${inboxMatch.status}）。`,\n"
    "        })\n"
    "        continue\n"
    "      }\n"
    "    }\n\n"
    "    const latestFeedback = latestExplicitFeedbackForCandidate(timeline, candidate, now)",
)
replace_once(
    'gateway/proposeChanges.ts',
    "        snapshot.data.timeline ?? [],\n      )",
    "        snapshot.data.timeline ?? [],\n        snapshot.data.discoveryInbox ?? [],\n      )",
)

# Extend discovery context output and instructions.
replace_once(
    'src/ai/readLayer.ts',
    "  discoveryHistorySummary: {\n    accepted: number\n    rejected: number\n    filtered: number\n    duplicate: number\n    deferred: number\n  }\n  instructions: string[]",
    "  discoveryHistorySummary: {\n"
    "    accepted: number\n"
    "    rejected: number\n"
    "    filtered: number\n"
    "    duplicate: number\n"
    "    deferred: number\n"
    "  }\n"
    "  discoveryInboxSummary: { new: number; seen: number; later: number; dismissed: number; promoted: number }\n"
    "  discoveryInbox: Array<{\n"
    "    inboxId: string\n"
    "    company: string\n"
    "    role: string\n"
    "    status: string\n"
    "    updatedAt: string\n"
    "    sourceUrl: string\n"
    "  }>\n"
    "  instructions: string[]",
)
replace_once(
    'src/ai/readLayer.ts',
    "  const historySummary = discoveryFeedbackSummary(history)\n\n  return {",
    "  const historySummary = discoveryFeedbackSummary(history)\n"
    "  const inbox = [...(snapshot.data.discoveryInbox ?? [])]\n"
    "    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))\n"
    "  const inboxSummary = { new: 0, seen: 0, later: 0, dismissed: 0, promoted: 0 }\n"
    "  for (const item of inbox) inboxSummary[item.status] += 1\n\n"
    "  return {",
)
replace_once(
    'src/ai/readLayer.ts',
    "    discoveryHistorySummary: historySummary,\n    instructions: [",
    "    discoveryHistorySummary: historySummary,\n"
    "    discoveryInboxSummary: inboxSummary,\n"
    "    discoveryInbox: inbox.slice(0, 100).map((item) => ({\n"
    "      inboxId: item.id,\n"
    "      company: item.company,\n"
    "      role: item.role,\n"
    "      status: item.status,\n"
    "      updatedAt: item.updatedAt,\n"
    "      sourceUrl: item.sourceUrl,\n"
    "    })),\n"
    "    instructions: [",
)
replace_once(
    'src/ai/readLayer.ts',
    "      'Avoid recentlyRejected roles unless the user explicitly asks to reconsider them; the quality gate also suppresses highly similar recent rejections.',\n      'Use propose_changes",
    "      'Avoid recentlyRejected roles unless the user explicitly asks to reconsider them; the quality gate also suppresses highly similar recent rejections.',\n"
    "      'Do not repeatedly surface roles already present in discoveryInbox with new, seen or later status; dismissed inbox items are suppressed for 120 days.',\n"
    "      'Use propose_changes",
)

# 4) Review page can explicitly save signed candidates into Inbox without adding Opportunities.
replace_once(
    'src/aiAccess/McpProposalReview.tsx',
    "import { discardChangeSet, savePendingChangeSet } from '../db.js'\n",
    "import { discardChangeSet, savePendingChangeSet } from '../db.js'\n"
    "import { saveDiscoveryInboxFromChangeSet } from '../discoveryInboxStore.js'\n",
)
replace_once(
    'src/aiAccess/McpProposalReview.tsx',
    "  async function discardProposal() {",
    "  async function saveToInbox() {\n"
    "    if (!proposal || !discoveryOperations.length) return\n"
    "    setBusy(true)\n"
    "    setError('')\n"
    "    try {\n"
    "      await assertMcpChangeSetBaseline(proposal.changeSet)\n"
    "      const saved = await saveDiscoveryInboxFromChangeSet(proposal.changeSet)\n"
    "      await savePendingChangeSet(proposal.changeSet)\n"
    "      await discardChangeSet(proposal.changeSet.id)\n"
    "      announceWorkspaceChange()\n"
    "      if (cloud.session && !cloud.checkpoint.conflict) {\n"
    "        try {\n"
    "          await cloud.syncNow()\n"
    "          setResult(zh ? `已保存 ${saved} 个岗位到发现箱，没有加入 Opportunities；已请求同步到 Google Drive。` : `Saved ${saved} jobs to Discovery Inbox without adding Opportunities; Google Drive sync was requested.`)\n"
    "        } catch {\n"
    "          setResult(zh ? `已保存 ${saved} 个岗位到本机发现箱，没有加入 Opportunities；Google Drive 暂未同步。` : `Saved ${saved} jobs to the local Discovery Inbox without adding Opportunities; Google Drive sync did not complete.`)\n"
    "        }\n"
    "      } else {\n"
    "        setResult(zh ? `已保存 ${saved} 个岗位到本机发现箱，没有加入 Opportunities。` : `Saved ${saved} jobs to the local Discovery Inbox without adding Opportunities.`)\n"
    "      }\n"
    "    } catch (caught) {\n"
    "      setError(caught instanceof Error ? caught.message : String(caught))\n"
    "    } finally {\n"
    "      setBusy(false)\n"
    "    }\n"
    "  }\n\n"
    "  async function discardProposal() {",
)
replace_once(
    'src/aiAccess/McpProposalReview.tsx',
    "            <>\n              <button disabled={busy} onClick={() => { void discardProposal() }}>",
    "            <>\n"
    "              {discoveryOperations.length ? <button disabled={busy} onClick={() => { void saveToInbox() }}>{zh ? '保存到发现箱' : 'Save to Inbox'}</button> : null}\n"
    "              <button disabled={busy} onClick={() => { void discardProposal() }}>",
)

# 5) Dedicated Inbox page.
write('src/DiscoveryInboxView.tsx', r'''
import { useEffect, useMemo, useState } from 'react'
import { DISCOVERY_REJECTION_REASON_OPTIONS } from './discoveryFeedback.js'
import {
  getAllDiscoveryInboxItems,
  promoteDiscoveryInboxItem,
  updateDiscoveryInboxStatus,
} from './discoveryInboxStore.js'
import { useCloud } from './cloud/CloudContext.js'
import { useUiLanguage } from './uiLanguage.js'
import type { DiscoveryInboxItem, DiscoveryInboxStatus, DiscoveryRejectionReason } from './model.js'
import './discoveryInbox.css'

const statusOrder: DiscoveryInboxStatus[] = ['new', 'later', 'seen', 'dismissed', 'promoted']

function statusLabel(status: DiscoveryInboxStatus, zh: boolean) {
  const labels: Record<DiscoveryInboxStatus, [string, string]> = {
    new: ['新发现', 'New'],
    seen: ['已看', 'Seen'],
    later: ['稍后再看', 'Later'],
    dismissed: ['不感兴趣', 'Dismissed'],
    promoted: ['已加入机会池', 'Promoted'],
  }
  return labels[status][zh ? 0 : 1]
}

export default function DiscoveryInboxView() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const cloud = useCloud()
  const [items, setItems] = useState<DiscoveryInboxItem[]>([])
  const [filter, setFilter] = useState<DiscoveryInboxStatus | 'all'>('all')
  const [busyId, setBusyId] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [reasons, setReasons] = useState<Record<string, DiscoveryRejectionReason>>({})

  async function reload() {
    const next = await getAllDiscoveryInboxItems()
    setItems(next)
    setReasons((current) => Object.fromEntries(next.map((item) => [item.id, current[item.id] ?? item.rejectionReason ?? 'not_interested'])))
  }

  useEffect(() => { void reload() }, [])

  const counts = useMemo(() => {
    const result: Record<DiscoveryInboxStatus, number> = { new: 0, seen: 0, later: 0, dismissed: 0, promoted: 0 }
    for (const item of items) result[item.status] += 1
    return result
  }, [items])

  const visible = filter === 'all' ? items : items.filter((item) => item.status === filter)

  async function syncAfterMutation(success: string) {
    await reload()
    window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
    if (cloud.session && !cloud.checkpoint.conflict) {
      try {
        await cloud.syncNow()
        setMessage(`${success}${zh ? '，并已请求同步到 Google Drive。' : '; Google Drive sync requested.'}`)
      } catch {
        setMessage(`${success}${zh ? '；Google Drive 暂未同步。' : '; Google Drive sync did not complete.'}`)
      }
    } else setMessage(success)
  }

  async function mutate(item: DiscoveryInboxItem, status: DiscoveryInboxStatus) {
    setBusyId(item.id)
    setError('')
    setMessage('')
    try {
      await updateDiscoveryInboxStatus(item.id, status, status === 'dismissed' ? reasons[item.id] : undefined)
      await syncAfterMutation(zh ? '发现箱状态已更新' : 'Discovery Inbox updated')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally { setBusyId('') }
  }

  async function promote(item: DiscoveryInboxItem) {
    setBusyId(item.id)
    setError('')
    setMessage('')
    try {
      await promoteDiscoveryInboxItem(item.id)
      await syncAfterMutation(zh ? '岗位已加入 Opportunities' : 'Job added to Opportunities')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally { setBusyId('') }
  }

  return (
    <section className="discovery-inbox-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">AI JOB DISCOVERY · V1.4</div>
          <h1>{zh ? '发现箱' : 'Discovery Inbox'}</h1>
          <p>{zh ? '把“值得以后处理”与“已经进入机会池”分开。发现箱不会自动投递，也不会自动把候选变成 Opportunity。' : 'Keep candidates worth revisiting separate from Opportunities. Inbox items never auto-apply or auto-promote.'}</p>
        </div>
      </header>

      <div className="discovery-inbox-metrics">
        {statusOrder.map((status) => <button key={status} className={filter === status ? 'active' : ''} onClick={() => setFilter(status)}><span>{statusLabel(status, zh)}</span><strong>{counts[status]}</strong></button>)}
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}><span>{zh ? '全部' : 'All'}</span><strong>{items.length}</strong></button>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}

      {!visible.length ? <div className="empty-card"><strong>{zh ? '当前没有这一类候选' : 'No candidates in this view'}</strong><p>{zh ? '从 ChatGPT 岗位发现审阅页选择“保存到发现箱”后，候选会出现在这里。' : 'Use Save to Inbox from a ChatGPT discovery review to stage candidates here.'}</p></div> : null}

      <div className="discovery-inbox-list">
        {visible.map((item) => (
          <article key={item.id} className={`discovery-inbox-item status-${item.status}`}>
            <div className="discovery-inbox-title">
              <div><strong>{item.company}</strong><h3>{item.role}</h3></div>
              <span>{statusLabel(item.status, zh)}</span>
            </div>
            <div className="discovery-inbox-facts">
              <span>{zh ? '地点' : 'Location'}：{item.location ?? (zh ? '来源未明确' : 'Not stated')}</span>
              <span>{zh ? '薪资' : 'Compensation'}：{item.compensationText ?? (zh ? '来源未明确' : 'Not stated')}</span>
              <span>{zh ? '匹配度' : 'Fit'}：{item.fitScore}</span>
              <span>{zh ? '机会价值' : 'Opportunity'}：{item.opportunityValue}</span>
            </div>
            <p>{item.rationale}</p>
            {item.profileWarnings?.length ? <div className="discovery-inbox-warnings">{item.profileWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
            <a href={item.sourceUrl} target="_blank" rel="noreferrer">{zh ? '查看招聘来源' : 'Open source'} · {item.sourceTitle}</a>

            {item.status !== 'promoted' ? (
              <div className="discovery-inbox-actions">
                {item.status !== 'seen' && item.status !== 'dismissed' ? <button disabled={busyId === item.id} onClick={() => { void mutate(item, 'seen') }}>{zh ? '已看' : 'Seen'}</button> : null}
                {item.status !== 'later' && item.status !== 'dismissed' ? <button disabled={busyId === item.id} onClick={() => { void mutate(item, 'later') }}>{zh ? '稍后再看' : 'Later'}</button> : null}
                {(item.status === 'later' || item.status === 'seen' || item.status === 'dismissed') ? <button disabled={busyId === item.id} onClick={() => { void mutate(item, 'new') }}>{zh ? '重新考虑' : 'Reconsider'}</button> : null}
                {item.status !== 'dismissed' ? (
                  <label className="discovery-inbox-dismiss">
                    <select value={reasons[item.id] ?? 'not_interested'} onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value as DiscoveryRejectionReason }))}>
                      {DISCOVERY_REJECTION_REASON_OPTIONS.map((option) => <option key={option.value} value={option.value}>{zh ? option.zh : option.en}</option>)}
                    </select>
                    <button disabled={busyId === item.id} onClick={() => { void mutate(item, 'dismissed') }}>{zh ? '不感兴趣' : 'Dismiss'}</button>
                  </label>
                ) : null}
                <button className="primary" disabled={busyId === item.id} onClick={() => { void promote(item) }}>{zh ? '加入 Opportunities' : 'Add to Opportunities'}</button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  )
}
''')

write('src/discoveryInbox.css', r'''
.discovery-inbox-page { display: grid; gap: 18px; }
.discovery-inbox-metrics { display: flex; gap: 8px; flex-wrap: wrap; }
.discovery-inbox-metrics button { min-width: 104px; display: flex; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--line, #ded8cc); border-radius: 12px; background: rgba(255,255,255,.55); color: inherit; cursor: pointer; }
.discovery-inbox-metrics button.active { border-color: #292720; background: #292720; color: #fff; }
.discovery-inbox-list { display: grid; gap: 12px; }
.discovery-inbox-item { padding: 18px; border: 1px solid var(--line, #ded8cc); border-radius: 18px; background: rgba(255,255,255,.58); }
.discovery-inbox-item.status-dismissed { opacity: .72; }
.discovery-inbox-title { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.discovery-inbox-title strong { font-size: 13px; opacity: .68; }
.discovery-inbox-title h3 { margin: 4px 0 0; font-size: 20px; }
.discovery-inbox-title > span { padding: 5px 9px; border-radius: 999px; background: rgba(41,39,32,.07); font-size: 11px; font-weight: 700; }
.discovery-inbox-facts { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 12px; font-size: 12px; color: var(--muted, #6f6a61); }
.discovery-inbox-item > p { margin: 12px 0; line-height: 1.6; font-size: 13px; }
.discovery-inbox-item > a { color: #315b75; font-size: 12px; }
.discovery-inbox-warnings { display: grid; gap: 5px; margin: 10px 0; }
.discovery-inbox-warnings span { padding: 7px 9px; border-radius: 9px; background: #fff1de; color: #80531e; font-size: 12px; }
.discovery-inbox-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; }
.discovery-inbox-actions button, .discovery-inbox-actions select { min-height: 36px; border: 1px solid var(--line, #ded8cc); border-radius: 10px; background: rgba(255,255,255,.7); color: inherit; padding: 7px 10px; }
.discovery-inbox-actions button { cursor: pointer; }
.discovery-inbox-actions button.primary { background: #292720; color: #fff; border-color: #292720; }
.discovery-inbox-actions button:disabled { opacity: .5; cursor: wait; }
.discovery-inbox-dismiss { display: inline-flex; gap: 6px; align-items: center; }
@media (max-width: 720px) { .discovery-inbox-title { flex-direction: column; } .discovery-inbox-dismiss { width: 100%; } .discovery-inbox-dismiss select { flex: 1; } }
''')

replace_once(
    'src/AppV5.tsx',
    "import DiscoveryProfileCard from './DiscoveryProfileCard.js'\n",
    "import DiscoveryProfileCard from './DiscoveryProfileCard.js'\n"
    "import DiscoveryInboxView from './DiscoveryInboxView.js'\n",
)
replace_once(
    'src/AppV5.tsx',
    "type Page = 'today' | 'opportunities' | 'pipeline' | 'prep' | 'timeline' | 'rules' | 'settings'",
    "type Page = 'today' | 'discovery' | 'opportunities' | 'pipeline' | 'prep' | 'timeline' | 'rules' | 'settings'",
)
replace_once(
    'src/AppV5.tsx',
    "const navigation: Page[] = ['today', 'opportunities', 'pipeline', 'prep', 'timeline', 'rules', 'settings']",
    "const navigation: Page[] = ['today', 'discovery', 'opportunities', 'pipeline', 'prep', 'timeline', 'rules', 'settings']",
)
replace_once(
    'src/AppV5.tsx',
    "{t(`nav.${item}` as 'nav.today' | 'nav.opportunities' | 'nav.pipeline' | 'nav.prep' | 'nav.timeline' | 'nav.rules' | 'nav.settings')}",
    "{t(`nav.${item}` as 'nav.today' | 'nav.discovery' | 'nav.opportunities' | 'nav.pipeline' | 'nav.prep' | 'nav.timeline' | 'nav.rules' | 'nav.settings')}",
)
replace_once(
    'src/AppV5.tsx',
    "        {!loading && page === 'opportunities' ? (",
    "        {!loading && page === 'discovery' ? <DiscoveryInboxView /> : null}\n"
    "        {!loading && page === 'opportunities' ? (",
)
replace_once(
    'src/uiLanguage.tsx',
    "  'nav.today': ['今日', 'Today'],\n  'nav.opportunities':",
    "  'nav.today': ['今日', 'Today'],\n  'nav.discovery': ['发现箱', 'Discovery Inbox'],\n  'nav.opportunities':",
)

# 6) Health/version contract moves to v1.4 alpha without adding a new MCP tool.
replace_once('gateway/authenticatedRemoteHttp.ts', "export const AUTHENTICATED_GATEWAY_VERSION = '1.3.0-alpha.1' as const", "export const AUTHENTICATED_GATEWAY_VERSION = '1.4.0-alpha.1' as const")
replace_once('gateway/authenticatedRemoteHttp.ts', ' * Authenticated v1.3 runtime for real PJSDAS data.', ' * Authenticated v1.4 runtime for real PJSDAS data.')
replace_once(
    'api/health.ts',
    "  discoveredOpportunityProposals: true,\n} as const",
    "  discoveredOpportunityProposals: true,\n  discoveryInbox: 'v1.4-round-1',\n} as const",
)
replace_once('scripts/v13-production-smoke.mjs', "const expectedVersion = process.env.PJSDAS_EXPECTED_VERSION || '1.3.0-alpha.1'", "const expectedVersion = process.env.PJSDAS_EXPECTED_VERSION || '1.4.0-alpha.1'")
replace_once(
    'scripts/v13-production-smoke.mjs',
    "  assert(health.body?.capabilities?.discoveredOpportunityProposals === true, 'discovered-opportunity proposal capability is not advertised')\n",
    "  assert(health.body?.capabilities?.discoveredOpportunityProposals === true, 'discovered-opportunity proposal capability is not advertised')\n"
    "  assert(health.body?.capabilities?.discoveryInbox === 'v1.4-round-1', 'v1.4 Discovery Inbox capability is not advertised')\n",
)
replace_once('scripts/v13-production-smoke.mjs', "  console.log('PJSDAS v1.3 public production contract passed.')", "  console.log('PJSDAS v1.4 Round 1 public production contract passed.')")
replace_once('.github/workflows/v13-production-smoke.yml', "default: 1.3.0-alpha.1", "default: 1.4.0-alpha.1")

# 7) Tests.
write('tests/discoveryInbox.test.ts', r'''
import { describe, expect, it } from 'vitest'
import {
  createInboxPromotionChangeSet,
  discoveryInboxItemsFromChangeSet,
  mergeDiscoveryInboxItems,
  validateDiscoveryInboxItem,
} from '../src/discoveryInbox.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-INBOX',
  version: 1,
  source: 'mcp',
  status: 'pending',
  title: '岗位发现',
  createdAt: '2026-09-11T10:00:00.000Z',
  updatedAt: '2026-09-11T10:00:00.000Z',
  operations: [{
    id: 'discovery:add:job-1',
    kind: 'add_discovered_opportunity',
    summary: '新增发现岗位',
    opportunity: {
      id: 'job-1', company: '甲公司', role: 'AI 产品经理', currentStageLabel: '待投', processStage: 'not_applied', roleType: 'core', early: false,
      opportunityValue: 90, fitScore: 85, locallyManaged: true, importedAt: '2026-09-11T10:00:00.000Z',
      detail: { discovery: { sourceUrl: 'https://careers.example.com/job-1', sourceTitle: '甲公司 AI 产品经理', location: '北京', rationale: '匹配产品与 AI 方向。', discoveredAt: '2026-09-11T10:00:00.000Z', fitConfidence: 'high', opportunityValueConfidence: 'medium' } },
    },
  }],
}

describe('v1.4 discovery inbox', () => {
  it('creates valid durable inbox items from signed discovery operations', () => {
    const [item] = discoveryInboxItemsFromChangeSet(changeSet, new Date('2026-09-11T10:05:00.000Z'))
    expect(item.status).toBe('new')
    expect(item.sourceChangeSetId).toBe(changeSet.id)
    expect(validateDiscoveryInboxItem(item)).toEqual([])
  })

  it('preserves explicit lifecycle status when the same candidate is rediscovered', () => {
    const [first] = discoveryInboxItemsFromChangeSet(changeSet, new Date('2026-09-11T10:05:00.000Z'))
    const dismissed = { ...first, status: 'dismissed' as const, rejectionReason: 'location' as const }
    const [incoming] = discoveryInboxItemsFromChangeSet(changeSet, new Date('2026-09-11T11:05:00.000Z'))
    const merged = mergeDiscoveryInboxItems([dismissed], [incoming])
    expect(merged).toHaveLength(1)
    expect(merged[0].status).toBe('dismissed')
    expect(merged[0].rejectionReason).toBe('location')
  })

  it('creates a reviewable local ChangeSet instead of silently promoting a candidate', () => {
    const [item] = discoveryInboxItemsFromChangeSet(changeSet)
    const promotion = createInboxPromotionChangeSet(item, new Date('2026-09-11T12:00:00.000Z'))
    expect(promotion.status).toBe('pending')
    expect(promotion.source).toBe('user_action')
    expect(promotion.operations).toHaveLength(1)
    expect(promotion.operations[0].kind).toBe('add_discovered_opportunity')
  })
})
''')

# Add Inbox suppression test to existing quality suite.
replace_once(
    'tests/discoveryQuality.test.ts',
    "  it('deduplicates against existing similar roles and keeps only the strongest bounded review batch', () => {",
    "  it('does not reprocess active or recently dismissed Discovery Inbox candidates', () => {\n"
    "    const inboxBase = {\n"
    "      id: 'inbox-1', candidateOpportunityId: 'candidate-1', company: '甲公司', role: '产品经理（AI方向）', roleType: 'core' as const,\n"
    "      sourceUrl: 'https://careers.example.com/inbox', sourceTitle: '甲公司 AI 产品', rationale: '历史发现',\n"
    "      opportunityValue: 85, fitScore: 80, fitConfidence: 'high' as const, opportunityValueConfidence: 'high' as const,\n"
    "      discoveredAt: '2026-09-10T00:00:00.000Z', createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z',\n"
    "    }\n"
    "    const active = screenDiscoveryCandidates(profile(), [candidate({ company: '甲公司', role: 'AI 产品经理' })], [], weights, now, [], [{ ...inboxBase, status: 'later' as const }])\n"
    "    expect(active.accepted).toHaveLength(0)\n"
    "    expect(active.skippedDuplicates[0].reason).toContain('发现箱')\n"
    "    const dismissed = screenDiscoveryCandidates(profile(), [candidate({ company: '甲公司', role: 'AI 产品经理' })], [], weights, now, [], [{ ...inboxBase, status: 'dismissed' as const, rejectionReason: 'not_interested' as const }])\n"
    "    expect(dismissed.accepted).toHaveLength(0)\n"
    "    expect(dismissed.rejectedCandidates[0].reasons.join(' ')).toContain('发现箱')\n"
    "  })\n\n"
    "  it('deduplicates against existing similar roles and keeps only the strongest bounded review batch', () => {",
)

write('docs/V1_4_ROUND_1_DISCOVERY_INBOX.md', r'''
# PJSDAS v1.4 Round 1 — Discovery Inbox

## Goal

Separate "worth keeping for later" from "promote into the real Opportunities pool". v1.3 made web discovery safe and reviewable; v1.4 Round 1 makes it durable across multiple discovery sessions without forcing every candidate into Opportunities.

## User workflow

1. ChatGPT discovers public jobs and PJSDAS quality-gates them as before.
2. The signed review page now offers **Save to Discovery Inbox** in addition to per-job Apply / Discard.
3. Saving to Inbox is an explicit write, but it does **not** create Opportunities or application Actions.
4. The new top-level **Discovery Inbox** page supports explicit lifecycle states:
   - `new`
   - `seen`
   - `later`
   - `dismissed`
   - `promoted`
5. A user can promote an Inbox candidate into Opportunities. Promotion still uses a normal local ChangeSet and the existing discovered-opportunity apply path.
6. Inbox state is part of the workspace snapshot, Google Drive sync, fingerprint/conflict model, and backup restore path.

## Re-discovery control

- `new`, `seen`, and `later` candidates are treated as already represented and are not repeatedly sent back through review.
- `dismissed` candidates suppress highly similar same-company roles for 120 days.
- `promoted` candidates are also represented in Opportunities and therefore deduplicate through the normal Opportunity path.
- `get_discovery_context` exposes Inbox summary + candidates so ChatGPT can avoid repeated public-search processing before it calls `propose_changes`.

## Safety boundaries

- Opening a signed proposal link still performs no write.
- Save to Inbox requires an explicit user click and baseline validation.
- Inbox does not auto-apply, auto-submit, or auto-promote.
- Promote to Opportunities is an explicit user action and runs through a pending ChangeSet.
- Public-source evidence remains attached to every Inbox candidate.

## Non-goals

- No automatic job applications.
- No scheduled crawler.
- No silent movement from Inbox to Opportunities.
- No learned/implicit rewriting of Discovery Profile.
- No deletion/retention automation in Round 1.
''')

print('v1.4 Round 1 codemod applied')

# Keep the production health regression test aligned with the v1.4 gateway contract.
replace_once(
    'tests/healthApi.test.ts',
    "describes the authenticated v1.3 primary gateway without exposing demo data or secrets",
    "describes the authenticated v1.4 primary gateway without exposing demo data or secrets",
)
replace_once(
    'tests/healthApi.test.ts',
    "version: '1.3.0-alpha.1'",
    "version: '1.4.0-alpha.1'",
)
