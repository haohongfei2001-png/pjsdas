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
    if count != 1:
        raise RuntimeError(f'{path}: expected exactly one replacement target, found {count}: {old[:120]!r}')
    target.write_text(text.replace(old, new, 1), encoding='utf-8')


# 1) Durable discovery feedback types live in Timeline so they automatically sync
# through the existing workspace snapshot without a new IndexedDB store.
replace_once(
    'src/model.ts',
    "export type DiscoveryConfidence = 'high' | 'medium' | 'low'\n",
    "export type DiscoveryConfidence = 'high' | 'medium' | 'low'\n"
    "export type DiscoveryReviewDecision = 'accepted' | 'rejected' | 'filtered' | 'duplicate' | 'deferred'\n"
    "export type DiscoveryRejectionReason =\n"
    "  | 'location'\n"
    "  | 'compensation'\n"
    "  | 'role_direction'\n"
    "  | 'company_value'\n"
    "  | 'requirements'\n"
    "  | 'already_have_better'\n"
    "  | 'not_interested'\n"
    "  | 'other'\n",
)
replace_once(
    'src/model.ts',
    "  | 'change_set_applied'\n",
    "  | 'change_set_applied'\n"
    "  | 'discovery_accepted'\n"
    "  | 'discovery_rejected'\n"
    "  | 'discovery_filtered'\n"
    "  | 'discovery_duplicate'\n"
    "  | 'discovery_deferred'\n",
)
replace_once(
    'src/model.ts',
    "  sourceRef?: string\n  changes?: Record<string, TimelineFieldChange>\n",
    "  sourceRef?: string\n"
    "  discoveryDecision?: DiscoveryReviewDecision\n"
    "  discoveryReasonCode?: DiscoveryRejectionReason\n"
    "  discoveryQualityScore?: number\n"
    "  changes?: Record<string, TimelineFieldChange>\n",
)

write('src/discoveryFeedback.ts', r'''
import { assertChangeSetValid, type ChangeSetRecord } from './changeSet.js'
import type { McpDiscoveryReview } from './ai/mcpProposal.js'
import type {
  DiscoveryRejectionReason,
  DiscoveryReviewDecision,
  TimelineRecord,
} from './model.js'

type DiscoveryOperation = Extract<ChangeSetRecord['operations'][number], { kind: 'add_discovered_opportunity' }>

export const DISCOVERY_REJECTION_REASON_OPTIONS: Array<{
  value: DiscoveryRejectionReason
  zh: string
  en: string
}> = [
  { value: 'location', zh: '地点不合适', en: 'Location' },
  { value: 'compensation', zh: '薪资不合适', en: 'Compensation' },
  { value: 'role_direction', zh: '岗位方向不合适', en: 'Role direction' },
  { value: 'company_value', zh: '公司 / 机会价值不足', en: 'Company / opportunity value' },
  { value: 'requirements', zh: '要求不匹配', en: 'Requirements mismatch' },
  { value: 'already_have_better', zh: '已有更好的相似岗位', en: 'Better similar option exists' },
  { value: 'not_interested', zh: '暂时不感兴趣', en: 'Not interested' },
  { value: 'other', zh: '其他', en: 'Other' },
]

export interface DiscoveryRejectionSelection {
  code: DiscoveryRejectionReason
  note?: string
}

function compactIdentity(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}

function identity(company: string, role: string) {
  return `${compactIdentity(company)}|${compactIdentity(role)}`
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function reasonLabel(code: DiscoveryRejectionReason) {
  return DISCOVERY_REJECTION_REASON_OPTIONS.find((item) => item.value === code)?.zh ?? code
}

function feedbackId(changeSetId: string, decision: DiscoveryReviewDecision, company: string, role: string) {
  return `timeline:discovery-feedback:${changeSetId}:${decision}:${stableHash(identity(company, role))}`
}

function feedbackRecord(input: {
  changeSetId: string
  decision: DiscoveryReviewDecision
  company: string
  role: string
  occurredAt: string
  title: string
  detail?: string
  sourceRef?: string
  opportunityId?: string
  reasonCode?: DiscoveryRejectionReason
  qualityScore?: number
  source: 'user_action' | 'changeset'
}): TimelineRecord {
  return {
    id: feedbackId(input.changeSetId, input.decision, input.company, input.role),
    kind: input.decision === 'accepted'
      ? 'discovery_accepted'
      : input.decision === 'rejected'
        ? 'discovery_rejected'
        : input.decision === 'filtered'
          ? 'discovery_filtered'
          : input.decision === 'duplicate'
            ? 'discovery_duplicate'
            : 'discovery_deferred',
    category: 'opportunity',
    source: input.source,
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
    title: input.title,
    detail: input.detail,
    company: input.company,
    role: input.role,
    opportunityId: input.opportunityId,
    changeSetId: input.changeSetId,
    sourceRef: input.sourceRef,
    discoveryDecision: input.decision,
    discoveryReasonCode: input.reasonCode,
    discoveryQualityScore: input.qualityScore,
  }
}

export function deriveDiscoveryReviewChangeSet(
  changeSet: ChangeSetRecord,
  selectedOperationIds: ReadonlySet<string>,
) {
  const discovery = changeSet.operations.filter(
    (operation): operation is DiscoveryOperation => operation.kind === 'add_discovered_opportunity',
  )
  if (!discovery.length || discovery.length !== changeSet.operations.length) {
    throw new Error('只有独立的岗位发现 ChangeSet 支持逐岗位选择。')
  }

  const known = new Set(discovery.map((operation) => operation.id))
  for (const id of selectedOperationIds) {
    if (!known.has(id)) throw new Error(`岗位发现审阅包含未知 operation：${id}。`)
  }
  const selected = discovery.filter((operation) => selectedOperationIds.has(operation.id))
  if (!selected.length) throw new Error('至少选择一个岗位后才能应用；如整批都不要，请选择“放弃整批”。')

  const reviewed: ChangeSetRecord = {
    ...changeSet,
    title: `${changeSet.title} · 已选 ${selected.length}/${discovery.length}`,
    operations: selected,
  }
  assertChangeSetValid(reviewed)
  return reviewed
}

export function createDiscoveryFeedbackRecords(
  changeSet: ChangeSetRecord,
  selectedOperationIds: ReadonlySet<string>,
  rejectionSelections: Record<string, DiscoveryRejectionSelection> = {},
  screening?: McpDiscoveryReview,
  now = new Date(),
) {
  const occurredAt = now.toISOString()
  const records: TimelineRecord[] = []
  const discovery = changeSet.operations.filter(
    (operation): operation is DiscoveryOperation => operation.kind === 'add_discovered_opportunity',
  )

  for (const operation of discovery) {
    const item = operation.opportunity
    const evidence = item.detail?.discovery
    if (selectedOperationIds.has(operation.id)) {
      records.push(feedbackRecord({
        changeSetId: changeSet.id,
        decision: 'accepted',
        company: item.company,
        role: item.role,
        occurredAt,
        title: '接受 AI 发现岗位',
        detail: evidence?.rationale,
        sourceRef: evidence?.sourceUrl,
        opportunityId: item.id,
        source: 'user_action',
      }))
      continue
    }

    const selection = rejectionSelections[operation.id] ?? { code: 'not_interested' as const }
    const note = selection.note?.trim()
    records.push(feedbackRecord({
      changeSetId: changeSet.id,
      decision: 'rejected',
      company: item.company,
      role: item.role,
      occurredAt,
      title: '拒绝 AI 发现岗位',
      detail: note ? `${reasonLabel(selection.code)}：${note}` : reasonLabel(selection.code),
      sourceRef: evidence?.sourceUrl,
      reasonCode: selection.code,
      source: 'user_action',
    }))
  }

  for (const item of screening?.skippedDuplicates ?? []) {
    records.push(feedbackRecord({
      changeSetId: changeSet.id,
      decision: 'duplicate',
      company: item.company,
      role: item.role,
      occurredAt,
      title: '岗位发现去重',
      detail: item.reason,
      source: 'changeset',
    }))
  }
  for (const item of screening?.rejectedCandidates ?? []) {
    records.push(feedbackRecord({
      changeSetId: changeSet.id,
      decision: 'filtered',
      company: item.company,
      role: item.role,
      occurredAt,
      title: '岗位发现质量闸门过滤',
      detail: item.reasons.join('；'),
      source: 'changeset',
    }))
  }
  for (const item of screening?.deferredCandidates ?? []) {
    records.push(feedbackRecord({
      changeSetId: changeSet.id,
      decision: 'deferred',
      company: item.company,
      role: item.role,
      occurredAt,
      title: '岗位发现暂缓审阅',
      detail: item.reason,
      qualityScore: item.qualityScore,
      source: 'changeset',
    }))
  }

  return records
}

function feedbackRecords(timeline: TimelineRecord[]) {
  return timeline.filter((item): item is TimelineRecord & {
    company: string
    role: string
    discoveryDecision: DiscoveryReviewDecision
  } => Boolean(item.company && item.role && item.discoveryDecision))
}

export function discoveryFeedbackSummary(timeline: TimelineRecord[]) {
  const latest = new Map<string, ReturnType<typeof feedbackRecords>[number]>()
  const sorted = feedbackRecords(timeline)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt))
  for (const item of sorted) {
    const key = identity(item.company, item.role)
    if (!latest.has(key)) latest.set(key, item)
  }
  const summary = { accepted: 0, rejected: 0, filtered: 0, duplicate: 0, deferred: 0 }
  for (const item of latest.values()) summary[item.discoveryDecision] += 1
  return summary
}

export function recentRejectedDiscoveryFeedback(
  timeline: TimelineRecord[],
  now = new Date(),
  windowDays = 120,
) {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000
  const latestUserDecision = new Map<string, ReturnType<typeof feedbackRecords>[number]>()
  const sorted = feedbackRecords(timeline)
    .filter((item) => item.discoveryDecision === 'accepted' || item.discoveryDecision === 'rejected')
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt))

  for (const item of sorted) {
    const key = identity(item.company, item.role)
    if (!latestUserDecision.has(key)) latestUserDecision.set(key, item)
  }

  return [...latestUserDecision.values()]
    .filter((item) => item.discoveryDecision === 'rejected' && new Date(item.occurredAt).getTime() >= cutoff)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
}
''')

write('src/discoveryFeedbackStore.ts', r'''
import { dbPromise } from './db.js'
import type { TimelineRecord } from './model.js'

export async function saveDiscoveryFeedbackRecords(records: TimelineRecord[]) {
  if (!records.length) return
  const db = await dbPromise
  const tx = db.transaction('timeline', 'readwrite')
  const store = tx.objectStore('timeline')
  for (const record of records) await store.put(record)
  await tx.done
}
''')

# 2) Signed proposal envelope now carries the deterministic quality-gate diagnostics
# so the review UI can explain why search results disappeared before review.
replace_once(
    'src/ai/mcpProposal.ts',
    "export interface McpProposalEnvelope {\n  version: typeof MCP_PROPOSAL_VERSION\n  workspaceVersion?: string\n  expiresAt: string\n  changeSet: ChangeSetRecord\n}\n",
    "export interface McpDiscoveryReviewItem {\n"
    "  company: string\n"
    "  role: string\n"
    "  reason?: string\n"
    "  reasons?: string[]\n"
    "  qualityScore?: number\n"
    "}\n\n"
    "export interface McpDiscoveryReview {\n"
    "  received: number\n"
    "  accepted: number\n"
    "  duplicateCount: number\n"
    "  rejectedCount: number\n"
    "  deferredCount: number\n"
    "  skippedDuplicates: McpDiscoveryReviewItem[]\n"
    "  rejectedCandidates: McpDiscoveryReviewItem[]\n"
    "  deferredCandidates: McpDiscoveryReviewItem[]\n"
    "}\n\n"
    "export interface McpProposalEnvelope {\n"
    "  version: typeof MCP_PROPOSAL_VERSION\n"
    "  workspaceVersion?: string\n"
    "  expiresAt: string\n"
    "  changeSet: ChangeSetRecord\n"
    "  discoveryReview?: McpDiscoveryReview\n"
    "}\n",
)
replace_once(
    'src/ai/mcpProposal.ts',
    "function validIso(value: unknown) {\n  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())\n}\n\n",
    "function validIso(value: unknown) {\n"
    "  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())\n"
    "}\n\n"
    "function validateDiscoveryReview(value: unknown): asserts value is McpDiscoveryReview {\n"
    "  if (!isObject(value)) throw new Error('PJSDAS discovery review metadata is invalid.')\n"
    "  for (const key of ['received', 'accepted', 'duplicateCount', 'rejectedCount', 'deferredCount'] as const) {\n"
    "    const count = value[key]\n"
    "    if (!Number.isInteger(count) || Number(count) < 0 || Number(count) > 20) {\n"
    "      throw new Error(`PJSDAS discovery review ${key} is invalid.`)\n"
    "    }\n"
    "  }\n"
    "  for (const key of ['skippedDuplicates', 'rejectedCandidates', 'deferredCandidates'] as const) {\n"
    "    const items = value[key]\n"
    "    if (!Array.isArray(items) || items.length > 20) throw new Error(`PJSDAS discovery review ${key} is invalid.`)\n"
    "    for (const item of items) {\n"
    "      if (!isObject(item) || typeof item.company !== 'string' || !item.company.trim() || typeof item.role !== 'string' || !item.role.trim()) {\n"
    "        throw new Error(`PJSDAS discovery review ${key} contains an invalid candidate.`)\n"
    "      }\n"
    "      if (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 1000)) throw new Error('PJSDAS discovery review reason is invalid.')\n"
    "      if (item.reasons !== undefined && (!Array.isArray(item.reasons) || item.reasons.length > 10 || item.reasons.some((reason) => typeof reason !== 'string' || reason.length > 1000))) throw new Error('PJSDAS discovery review reasons are invalid.')\n"
    "      if (item.qualityScore !== undefined && (typeof item.qualityScore !== 'number' || item.qualityScore < 0 || item.qualityScore > 100)) throw new Error('PJSDAS discovery review quality score is invalid.')\n"
    "    }\n"
    "  }\n"
    "}\n\n",
)
replace_once(
    'src/ai/mcpProposal.ts',
    "export function createMcpProposalEnvelope(\n  changeSet: ChangeSetRecord,\n  workspaceVersion?: string,\n  now = new Date(),\n): McpProposalEnvelope {\n  assertChangeSetValid(changeSet)\n  return {\n    version: MCP_PROPOSAL_VERSION,\n    workspaceVersion,\n    expiresAt: new Date(now.getTime() + MCP_PROPOSAL_TTL_MS).toISOString(),\n    changeSet,\n  }\n}\n",
    "export function createMcpProposalEnvelope(\n"
    "  changeSet: ChangeSetRecord,\n"
    "  workspaceVersion?: string,\n"
    "  now = new Date(),\n"
    "  discoveryReview?: McpDiscoveryReview,\n"
    "): McpProposalEnvelope {\n"
    "  assertChangeSetValid(changeSet)\n"
    "  if (discoveryReview) validateDiscoveryReview(discoveryReview)\n"
    "  return {\n"
    "    version: MCP_PROPOSAL_VERSION,\n"
    "    workspaceVersion,\n"
    "    expiresAt: new Date(now.getTime() + MCP_PROPOSAL_TTL_MS).toISOString(),\n"
    "    changeSet,\n"
    "    discoveryReview,\n"
    "  }\n"
    "}\n",
)
replace_once(
    'src/ai/mcpProposal.ts',
    "  if (!validIso(envelope.expiresAt)) throw new Error('PJSDAS proposal expiry is invalid.')\n  return toBase64Url(JSON.stringify(envelope))\n",
    "  if (!validIso(envelope.expiresAt)) throw new Error('PJSDAS proposal expiry is invalid.')\n"
    "  if (envelope.discoveryReview) validateDiscoveryReview(envelope.discoveryReview)\n"
    "  return toBase64Url(JSON.stringify(envelope))\n",
)
replace_once(
    'src/ai/mcpProposal.ts',
    "  if (!validIso(parsed.expiresAt)) throw new Error('PJSDAS proposal expiry is invalid.')\n  assertChangeSetValid(parsed.changeSet)\n",
    "  if (!validIso(parsed.expiresAt)) throw new Error('PJSDAS proposal expiry is invalid.')\n"
    "  if (parsed.discoveryReview !== undefined) validateDiscoveryReview(parsed.discoveryReview)\n"
    "  assertChangeSetValid(parsed.changeSet)\n",
)

replace_once(
    'gateway/proposalToken.ts',
    "  type McpProposalEnvelope,\n} from '../src/ai/mcpProposal.js'\n",
    "  type McpDiscoveryReview,\n  type McpProposalEnvelope,\n} from '../src/ai/mcpProposal.js'\n",
)
replace_once(
    'gateway/proposalToken.ts',
    "  secret: string,\n  now = new Date(),\n) {\n  const envelope = createMcpProposalEnvelope(changeSet, workspaceVersion, now)\n",
    "  secret: string,\n"
    "  now = new Date(),\n"
    "  discoveryReview?: McpDiscoveryReview,\n"
    ") {\n"
    "  const envelope = createMcpProposalEnvelope(changeSet, workspaceVersion, now, discoveryReview)\n",
)

# 3) Round 3 quality gate remembers explicit rejection feedback for 120 days.
replace_once(
    'src/discoveryQuality.ts',
    "import type { DiscoveryConfidence, Opportunity, OpportunityRole } from './model.js'\n",
    "import { recentRejectedDiscoveryFeedback } from './discoveryFeedback.js'\n"
    "import type { DiscoveryConfidence, Opportunity, OpportunityRole, TimelineRecord } from './model.js'\n",
)
replace_once(
    'src/discoveryQuality.ts',
    "  weights: DecisionWeights,\n  now = new Date(),\n): DiscoveryScreeningResult<T> {\n",
    "  weights: DecisionWeights,\n"
    "  now = new Date(),\n"
    "  timeline: TimelineRecord[] = [],\n"
    "): DiscoveryScreeningResult<T> {\n",
)
replace_once(
    'src/discoveryQuality.ts',
    "  const rejectedCandidates: DiscoveryScreeningResult<T>['rejectedCandidates'] = []\n\n  for (const candidate of candidates) {\n",
    "  const rejectedCandidates: DiscoveryScreeningResult<T>['rejectedCandidates'] = []\n"
    "  const recentlyRejected = recentRejectedDiscoveryFeedback(timeline, now)\n\n"
    "  for (const candidate of candidates) {\n"
    "    const priorRejection = recentlyRejected.find((item) =>\n"
    "      normalizedCompany(item.company) === normalizedCompany(candidate.company) &&\n"
    "      discoveryRoleSimilarity(item.role, candidate.role) >= 0.72\n"
    "    )\n"
    "    if (priorRejection) {\n"
    "      rejectedCandidates.push({\n"
    "        company: candidate.company,\n"
    "        role: candidate.role,\n"
    "        reasons: [`用户在最近 120 天已明确拒绝高度相似岗位“${priorRejection.company}｜${priorRejection.role}”。`],\n"
    "      })\n"
    "      continue\n"
    "    }\n\n",
)

# 4) The MCP proposal signs the screening diagnostics and passes timeline feedback into the gate.
replace_once(
    'gateway/proposeChanges.ts',
    "import { buildMcpProposalReviewUrl } from '../src/ai/mcpProposal.js'\n",
    "import { buildMcpProposalReviewUrl, type McpDiscoveryReview } from '../src/ai/mcpProposal.js'\n",
)
replace_once(
    'gateway/proposeChanges.ts',
    "export async function invokeProposeChanges(\n",
    "function discoveryReviewMetadata(\n"
    "  screening: NonNullable<ReturnType<typeof screenDiscoveryCandidates>>,\n"
    "): McpDiscoveryReview {\n"
    "  return {\n"
    "    received: screening.received,\n"
    "    accepted: screening.accepted.length,\n"
    "    duplicateCount: screening.skippedDuplicates.length,\n"
    "    rejectedCount: screening.rejectedCandidates.length,\n"
    "    deferredCount: screening.deferredCandidates.length,\n"
    "    skippedDuplicates: screening.skippedDuplicates.map((item) => ({ ...item })),\n"
    "    rejectedCandidates: screening.rejectedCandidates.map((item) => ({ ...item, reasons: [...item.reasons] })),\n"
    "    deferredCandidates: screening.deferredCandidates.map((item) => ({ ...item })),\n"
    "  }\n"
    "}\n\n"
    "export async function invokeProposeChanges(\n",
)
replace_once(
    'gateway/proposeChanges.ts',
    "        rules.weights,\n        now,\n      )\n",
    "        rules.weights,\n        now,\n        snapshot.data.timeline ?? [],\n      )\n",
)
replace_once(
    'gateway/proposeChanges.ts',
    "    const signedToken = await createSignedProposalToken(changeSet, context.workspaceVersion, options.signingKey, now)\n",
    "    const discoveryReview = discoveryScreening ? discoveryReviewMetadata(discoveryScreening) : undefined\n"
    "    const signedToken = await createSignedProposalToken(changeSet, context.workspaceVersion, options.signingKey, now, discoveryReview)\n",
)

# 5) Read context exposes explicit user feedback, so future discovery can avoid re-suggesting rejected roles.
replace_once(
    'src/ai/readLayer.ts',
    "import { discoveryProfileForSnapshot, type DiscoveryProfile } from '../discoveryProfile.js'\n",
    "import { discoveryProfileForSnapshot, type DiscoveryProfile } from '../discoveryProfile.js'\n"
    "import { discoveryFeedbackSummary, recentRejectedDiscoveryFeedback } from '../discoveryFeedback.js'\n",
)
replace_once(
    'src/ai/readLayer.ts',
    "  recentlyClosed: Array<{\n    opportunityId: string\n    company: string\n    role: string\n  }>\n  instructions: string[]\n}\n",
    "  recentlyClosed: Array<{\n"
    "    opportunityId: string\n"
    "    company: string\n"
    "    role: string\n"
    "  }>\n"
    "  recentlyRejected: Array<{\n"
    "    company: string\n"
    "    role: string\n"
    "    rejectedAt: string\n"
    "    reasonCode?: string\n"
    "    reason?: string\n"
    "  }>\n"
    "  discoveryHistorySummary: {\n"
    "    accepted: number\n"
    "    rejected: number\n"
    "    filtered: number\n"
    "    duplicate: number\n"
    "    deferred: number\n"
    "  }\n"
    "  instructions: string[]\n"
    "}\n",
)
replace_once(
    'src/ai/readLayer.ts',
    "  const recentlyClosed = workspace.opportunities\n    .filter((item) => item.processStage === 'closed')\n    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))\n    .slice(0, 60)\n\n  return {\n",
    "  const recentlyClosed = workspace.opportunities\n"
    "    .filter((item) => item.processStage === 'closed')\n"
    "    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))\n"
    "    .slice(0, 60)\n"
    "  const history = snapshot.data.timeline ?? []\n"
    "  const recentlyRejected = recentRejectedDiscoveryFeedback(history, context.now).slice(0, 40)\n"
    "  const historySummary = discoveryFeedbackSummary(history)\n\n"
    "  return {\n",
)
replace_once(
    'src/ai/readLayer.ts',
    "    recentlyClosed: recentlyClosed.map((item) => ({\n      opportunityId: item.id,\n      company: item.company,\n      role: item.role,\n    })),\n    instructions: [\n",
    "    recentlyClosed: recentlyClosed.map((item) => ({\n"
    "      opportunityId: item.id,\n"
    "      company: item.company,\n"
    "      role: item.role,\n"
    "    })),\n"
    "    recentlyRejected: recentlyRejected.map((item) => ({\n"
    "      company: item.company,\n"
    "      role: item.role,\n"
    "      rejectedAt: item.occurredAt,\n"
    "      reasonCode: item.discoveryReasonCode,\n"
    "      reason: item.detail,\n"
    "    })),\n"
    "    discoveryHistorySummary: historySummary,\n"
    "    instructions: [\n",
)
replace_once(
    'src/ai/readLayer.ts',
    "      'Do not rediscover an obviously identical company+role already present in existingOpportunities.',\n",
    "      'Do not rediscover an obviously identical company+role already present in existingOpportunities.',\n"
    "      'Avoid recentlyRejected roles unless the user explicitly asks to reconsider them; the quality gate also suppresses highly similar recent rejections.',\n",
)

# 6) Replace the review UI with explicit per-candidate selection + rejection reasons + screening diagnostics.
write('src/aiAccess/McpProposalReview.tsx', r'''
import { useEffect, useMemo, useState } from 'react'
import { discardChangeSet, savePendingChangeSet } from '../db.js'
import {
  DISCOVERY_REJECTION_REASON_OPTIONS,
  createDiscoveryFeedbackRecords,
  deriveDiscoveryReviewChangeSet,
  type DiscoveryRejectionSelection,
} from '../discoveryFeedback.js'
import { saveDiscoveryFeedbackRecords } from '../discoveryFeedbackStore.js'
import {
  encodedProposalFromHash,
  removeProposalFromUrl,
  type McpProposalEnvelope,
} from '../ai/mcpProposal.js'
import { applyMcpChangeSetWithBaseline, assertMcpChangeSetBaseline } from '../ai/mcpProposalApply.js'
import { useCloud } from '../cloud/CloudContext.js'
import { getAccountCheckpoint } from '../cloud/syncState.js'
import { useUiLanguage } from '../uiLanguage.js'
import './mcpProposalReview.css'

const VERIFY_ENDPOINT = 'https://pjsdas-remote-alpha.vercel.app/api/proposal-verify'

function clearProposalHash() {
  if (typeof window === 'undefined') return
  const cleaned = removeProposalFromUrl(new URL(window.location.href))
  window.history.replaceState({}, '', `${cleaned.pathname}${cleaned.search}${cleaned.hash}`)
}

function announceWorkspaceChange() {
  window.setTimeout(() => window.dispatchEvent(new Event('pjsdas:workspace-replaced')), 0)
}

function driveVersion(workspaceVersion?: string) {
  return workspaceVersion?.startsWith('drive:') ? workspaceVersion.slice('drive:'.length) : undefined
}

function formatDeadline(value: string | undefined, zh: boolean) {
  if (!value) return zh ? '来源未明确' : 'Not stated by source'
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function confidenceLabel(value: string, zh: boolean) {
  if (!zh) return value
  if (value === 'high') return '高'
  if (value === 'medium') return '中'
  return '低'
}

function defaultRejectionSelections(ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, { code: 'not_interested' }])) as Record<string, DiscoveryRejectionSelection>
}

export default function McpProposalReview() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const cloud = useCloud()
  const [proposal, setProposal] = useState<McpProposalEnvelope | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [verifying, setVerifying] = useState(() => typeof window !== 'undefined' && Boolean(encodedProposalFromHash(window.location.hash)))
  const [result, setResult] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [rejectionSelections, setRejectionSelections] = useState<Record<string, DiscoveryRejectionSelection>>({})

  useEffect(() => {
    if (typeof window === 'undefined') return
    const token = encodedProposalFromHash(window.location.hash)
    if (!token) {
      setVerifying(false)
      return
    }

    let active = true
    void fetch(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as {
          proposal?: McpProposalEnvelope
          message?: string
        }
        if (!response.ok || !body.proposal) throw new Error(body.message || `Proposal verification failed (HTTP ${response.status}).`)
        return body.proposal
      })
      .then(async (verified) => {
        if (!active) return
        const proposedVersion = driveVersion(verified.workspaceVersion)
        if (proposedVersion) {
          const ownerId = cloud.device.workspaceOwnerUserId
          if (!ownerId) {
            throw new Error(zh
              ? '这条提议来自 Google Drive，但当前浏览器还没有可验证的 PJSDAS 云端基线。请先在“导入与设置”连接并同步 Google Drive，再让 ChatGPT 重新生成提议。'
              : 'This proposal came from Google Drive, but this browser has no verifiable PJSDAS cloud baseline. Connect and sync Google Drive in Import & Settings, then ask ChatGPT for a fresh proposal.')
          }
          const checkpoint = getAccountCheckpoint(ownerId)
          if (!checkpoint.lastSyncedVersion || proposedVersion !== checkpoint.lastSyncedVersion) {
            throw new Error(zh
              ? `这条提议基于 ${verified.workspaceVersion}，但本机最近同步版本是 ${checkpoint.lastSyncedVersion ? `drive:${checkpoint.lastSyncedVersion}` : '未知'}。请先同步 PJSDAS，再让 ChatGPT 重新生成提议。`
              : `This proposal was based on ${verified.workspaceVersion}, while this device last synced ${checkpoint.lastSyncedVersion ? `drive:${checkpoint.lastSyncedVersion}` : 'an unknown version'}. Sync PJSDAS first, then ask ChatGPT for a fresh proposal.`)
          }
        }
        await assertMcpChangeSetBaseline(verified.changeSet)
        if (!active) return
        const discoveryIds = verified.changeSet.operations
          .filter((item) => item.kind === 'add_discovered_opportunity')
          .map((item) => item.id)
        setSelectedIds(new Set(discoveryIds))
        setRejectionSelections(defaultRejectionSelections(discoveryIds))
        // Opening a signed review link remains non-mutating. Review feedback is
        // persisted only after explicit Apply or Discard.
        setProposal(verified)
      })
      .catch((caught) => {
        if (!active) return
        setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (!active) return
        clearProposalHash()
        setVerifying(false)
      })

    return () => { active = false }
  }, [])

  const operationSummary = useMemo(
    () => proposal?.changeSet.operations.map((item) => item.summary) ?? [],
    [proposal],
  )
  const discoveryOperations = useMemo(
    () => proposal?.changeSet.operations.filter((item) => item.kind === 'add_discovered_opportunity') ?? [],
    [proposal],
  )
  const selectedCount = discoveryOperations.filter((item) => selectedIds.has(item.id)).length

  function toggleDiscovery(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function setRejectionCode(id: string, code: DiscoveryRejectionSelection['code']) {
    setRejectionSelections((current) => ({
      ...current,
      [id]: { ...(current[id] ?? {}), code },
    }))
  }

  async function applyProposal() {
    if (!proposal) return
    setBusy(true)
    setError('')
    try {
      const reviewedChangeSet = discoveryOperations.length
        ? deriveDiscoveryReviewChangeSet(proposal.changeSet, selectedIds)
        : proposal.changeSet
      await assertMcpChangeSetBaseline(reviewedChangeSet)
      await savePendingChangeSet(reviewedChangeSet)
      await applyMcpChangeSetWithBaseline(reviewedChangeSet)

      let feedbackSaved = true
      if (discoveryOperations.length) {
        try {
          await saveDiscoveryFeedbackRecords(createDiscoveryFeedbackRecords(
            proposal.changeSet,
            selectedIds,
            rejectionSelections,
            proposal.discoveryReview,
          ))
        } catch {
          feedbackSaved = false
        }
      }

      announceWorkspaceChange()
      const feedbackNote = discoveryOperations.length && !feedbackSaved
        ? (zh ? '；岗位已应用，但发现反馈记录失败。' : '; jobs applied, but discovery feedback could not be saved.')
        : ''
      const selectionNote = discoveryOperations.length
        ? (zh ? `已选择 ${selectedCount}/${discoveryOperations.length} 个岗位。` : `Selected ${selectedCount}/${discoveryOperations.length} jobs.`)
        : ''

      if (cloud.session && !cloud.checkpoint.conflict) {
        try {
          await cloud.syncNow()
          setResult(zh
            ? `${selectionNote} ChangeSet 已应用，并已请求同步到 Google Drive${feedbackNote}`
            : `${selectionNote} ChangeSet applied and Google Drive sync was requested${feedbackNote}`)
        } catch {
          setResult(zh
            ? `${selectionNote} ChangeSet 已应用到本机；Google Drive 同步未完成，请稍后在“导入与设置”中同步${feedbackNote}`
            : `${selectionNote} ChangeSet applied locally; Google Drive sync did not complete. Sync later in Import & Settings${feedbackNote}`)
        }
      } else {
        setResult(zh
          ? `${selectionNote} ChangeSet 已应用到本机。Google Drive 当前未连接；请在“导入与设置”连接并同步，之后 ChatGPT 才能读取到新状态${feedbackNote}`
          : `${selectionNote} ChangeSet applied locally. Connect and sync Google Drive in Import & Settings before ChatGPT can read the new state${feedbackNote}`)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  async function discardProposal() {
    if (!proposal) return
    setBusy(true)
    setError('')
    try {
      await savePendingChangeSet(proposal.changeSet)
      await discardChangeSet(proposal.changeSet.id)
      let feedbackSaved = true
      if (discoveryOperations.length) {
        try {
          await saveDiscoveryFeedbackRecords(createDiscoveryFeedbackRecords(
            proposal.changeSet,
            new Set(),
            rejectionSelections,
            proposal.discoveryReview,
          ))
        } catch {
          feedbackSaved = false
        }
      }
      announceWorkspaceChange()
      if (discoveryOperations.length) {
        setResult(zh
          ? `整批岗位已放弃，没有加入 Opportunities。${feedbackSaved ? '已记录你的拒绝反馈，后续发现会尽量避免重复推荐。' : '拒绝反馈记录失败。'}`
          : `The batch was discarded and no jobs were added. ${feedbackSaved ? 'Your rejection feedback was saved for future discovery.' : 'Rejection feedback could not be saved.'}`)
      } else {
        setResult(zh ? '这条 ChatGPT 提议已放弃，没有修改求职数据。' : 'Proposal discarded. No job-search data was changed.')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!proposal && !error && !verifying) return null

  return (
    <div className="mcp-proposal-backdrop" role="dialog" aria-modal="true" aria-label={zh ? 'ChatGPT 修改提议' : 'ChatGPT change proposal'}>
      <section className={`mcp-proposal-card ${discoveryOperations.length ? 'discovery-review' : ''}`}>
        <div className="mcp-proposal-eyebrow">CHATGPT · CHANGESET · {discoveryOperations.length ? 'V1.3 · ROUND 3' : 'V1.2'}</div>
        <h2>{discoveryOperations.length ? (zh ? '逐岗位审阅发现结果' : 'Review discovered jobs') : (zh ? '审阅 ChatGPT 提议' : 'Review ChatGPT proposal')}</h2>

        {verifying ? <p className="mcp-proposal-safety">{zh ? '正在验证提议签名、有效期与本机工作区基线…' : 'Verifying proposal signature, expiry, and local workspace baseline…'}</p> : null}

        {proposal ? (
          <>
            <p className="mcp-proposal-safety">{discoveryOperations.length
              ? (zh
                ? '打开链接没有修改数据。你可以逐个取消不想要的岗位；只有勾选并应用的岗位会进入 Opportunities，未选择岗位会在你确认后记录为显式反馈。'
                : 'Opening this link changed no data. Select jobs individually; only selected jobs are added, while rejected jobs become explicit feedback after you confirm.')
              : (zh
                ? '打开这条链接没有修改任何 PJSDAS 数据。只有你点击“应用 ChangeSet”后，这些规范化修改才会进入求职数据。'
                : 'Opening this link changed no PJSDAS data. These normalized edits enter your job-search data only after you click Apply ChangeSet.')}</p>
            <div className="mcp-proposal-meta">
              <strong>{proposal.changeSet.title}</strong>
              <span>{proposal.changeSet.id}</span>
              {proposal.workspaceVersion ? <span>{zh ? '提议基于' : 'Proposed from'} {proposal.workspaceVersion}</span> : null}
              <span>{zh ? '链接有效至' : 'Link expires'} {new Date(proposal.expiresAt).toLocaleString()}</span>
            </div>

            {discoveryOperations.length ? (
              <>
                {proposal.discoveryReview ? (
                  <div className="mcp-discovery-screening">
                    <div className="mcp-discovery-screening-head">
                      <strong>{zh ? '质量闸门结果' : 'Quality gate'}</strong>
                      <span>{zh ? `搜索 ${proposal.discoveryReview.received} · 审阅 ${proposal.discoveryReview.accepted} · 去重 ${proposal.discoveryReview.duplicateCount} · 过滤 ${proposal.discoveryReview.rejectedCount} · 暂缓 ${proposal.discoveryReview.deferredCount}` : `searched ${proposal.discoveryReview.received} · review ${proposal.discoveryReview.accepted} · duplicates ${proposal.discoveryReview.duplicateCount} · filtered ${proposal.discoveryReview.rejectedCount} · deferred ${proposal.discoveryReview.deferredCount}`}</span>
                    </div>
                    {(proposal.discoveryReview.skippedDuplicates.length || proposal.discoveryReview.rejectedCandidates.length || proposal.discoveryReview.deferredCandidates.length) ? (
                      <details>
                        <summary>{zh ? '查看没有进入审阅区的岗位' : 'See jobs that did not enter review'}</summary>
                        <div className="mcp-discovery-screening-list">
                          {proposal.discoveryReview.skippedDuplicates.map((item) => <p key={`dup:${item.company}:${item.role}`}><b>{item.company}｜{item.role}</b> · {item.reason}</p>)}
                          {proposal.discoveryReview.rejectedCandidates.map((item) => <p key={`reject:${item.company}:${item.role}`}><b>{item.company}｜{item.role}</b> · {item.reasons?.join('；')}</p>)}
                          {proposal.discoveryReview.deferredCandidates.map((item) => <p key={`defer:${item.company}:${item.role}`}><b>{item.company}｜{item.role}</b> · {item.reason}</p>)}
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : null}

                <div className="mcp-discovery-selection-summary">
                  <strong>{zh ? `已选择 ${selectedCount}/${discoveryOperations.length}` : `${selectedCount}/${discoveryOperations.length} selected`}</strong>
                  <span>{zh ? '取消勾选后可记录拒绝原因。' : 'Unselect a job to record why you do not want it.'}</span>
                </div>

                <div className="mcp-discovery-list">
                  {discoveryOperations.map((operation) => {
                    const item = operation.opportunity
                    const evidence = item.detail?.discovery
                    const selected = selectedIds.has(operation.id)
                    const rejection = rejectionSelections[operation.id] ?? { code: 'not_interested' as const }
                    return (
                      <article className={`mcp-discovery-item ${selected ? 'selected' : 'rejected'}`} key={operation.id}>
                        <div className="mcp-discovery-review-choice">
                          <label>
                            <input type="checkbox" checked={selected} onChange={() => toggleDiscovery(operation.id)} />
                            <span>{selected ? (zh ? '加入 PJSDAS' : 'Add to PJSDAS') : (zh ? '不加入' : 'Do not add')}</span>
                          </label>
                        </div>
                        <div className="mcp-discovery-title">
                          <div>
                            <strong>{item.company}</strong>
                            <h3>{item.role}</h3>
                          </div>
                          <span>{item.roleType}</span>
                        </div>
                        <div className="mcp-discovery-facts">
                          <span>{zh ? '地点' : 'Location'}：{evidence?.location ?? (zh ? '来源未明确' : 'Not stated')}</span>
                          <span>{zh ? '截止' : 'Deadline'}：{formatDeadline(item.deadline, zh)}</span>
                          <span>{zh ? '薪资' : 'Compensation'}：{evidence?.compensationText ?? (zh ? '来源未明确' : 'Not stated')}</span>
                        </div>
                        <div className="mcp-discovery-scores">
                          <span>{zh ? '机会价值' : 'Opportunity'} <b>{item.opportunityValue}</b> · {confidenceLabel(evidence?.opportunityValueConfidence ?? 'low', zh)}</span>
                          <span>{zh ? '匹配度' : 'Fit'} <b>{item.fitScore}</b> · {confidenceLabel(evidence?.fitConfidence ?? 'low', zh)}</span>
                        </div>
                        {evidence?.rationale ? <p className="mcp-discovery-rationale">{evidence.rationale}</p> : null}
                        {evidence?.profileWarnings?.length ? (
                          <div className="mcp-discovery-warnings">
                            {evidence.profileWarnings.map((warning) => <span key={warning}>{warning}</span>)}
                          </div>
                        ) : null}
                        {!selected ? (
                          <label className="mcp-discovery-rejection-reason">
                            <span>{zh ? '不加入原因' : 'Reason'}</span>
                            <select value={rejection.code} onChange={(event) => setRejectionCode(operation.id, event.target.value as DiscoveryRejectionSelection['code'])}>
                              {DISCOVERY_REJECTION_REASON_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{zh ? option.zh : option.en}</option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        {evidence?.sourceUrl ? (
                          <a className="mcp-discovery-source" href={evidence.sourceUrl} target="_blank" rel="noreferrer">
                            {zh ? '查看招聘来源' : 'Open job source'} · {evidence.sourceTitle}
                          </a>
                        ) : null}
                      </article>
                    )
                  })}
                </div>
              </>
            ) : (
              <div className="mcp-proposal-ops">
                {operationSummary.map((summary, index) => (
                  <div key={`${proposal.changeSet.id}:${index}`}><span>{index + 1}</span><p>{summary}</p></div>
                ))}
              </div>
            )}
          </>
        ) : null}

        {error ? <div className="mcp-proposal-error">{error}</div> : null}
        {result ? <div className="mcp-proposal-result">{result}</div> : null}

        <div className="mcp-proposal-actions">
          {!result && proposal ? (
            <>
              <button disabled={busy} onClick={() => { void discardProposal() }}>{discoveryOperations.length ? (zh ? '放弃整批' : 'Discard batch') : (zh ? '放弃' : 'Discard')}</button>
              <button className="primary" disabled={busy || (discoveryOperations.length > 0 && selectedCount === 0)} onClick={() => { void applyProposal() }}>
                {busy ? '…' : discoveryOperations.length
                  ? (zh ? `应用已选择的 ${selectedCount} 个` : `Apply ${selectedCount} selected`)
                  : (zh ? '应用 ChangeSet' : 'Apply ChangeSet')}
              </button>
            </>
          ) : !verifying ? (
            <button className="primary" onClick={() => { setProposal(null); setError(''); setResult('') }}>{zh ? '关闭' : 'Close'}</button>
          ) : null}
        </div>
      </section>
    </div>
  )
}
''')

with (ROOT / 'src/aiAccess/mcpProposalReview.css').open('a', encoding='utf-8') as handle:
    handle.write(textwrap.dedent(r'''

.mcp-discovery-screening {
  margin: 16px 0;
  padding: 13px 14px;
  border: 1px solid rgba(41, 39, 32, 0.1);
  border-radius: 13px;
  background: rgba(49, 91, 117, 0.055);
}

.mcp-discovery-screening-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
}

.mcp-discovery-screening-head span {
  color: rgba(41, 39, 32, 0.64);
}

.mcp-discovery-screening details {
  margin-top: 9px;
  font-size: 12px;
}

.mcp-discovery-screening summary {
  cursor: pointer;
  color: #315b75;
}

.mcp-discovery-screening-list {
  display: grid;
  gap: 7px;
  margin-top: 9px;
}

.mcp-discovery-screening-list p {
  margin: 0;
  line-height: 1.5;
  color: rgba(41, 39, 32, 0.7);
}

.mcp-discovery-selection-summary {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: baseline;
  margin: 16px 0 8px;
  font-size: 12px;
}

.mcp-discovery-selection-summary span {
  color: rgba(41, 39, 32, 0.58);
}

.mcp-discovery-item.rejected {
  opacity: 0.76;
  background: rgba(255, 255, 255, 0.28);
}

.mcp-discovery-review-choice {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.mcp-discovery-review-choice label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 700;
}

.mcp-discovery-rejection-reason {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 12px;
  font-size: 12px;
}

.mcp-discovery-rejection-reason select {
  flex: 1;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid rgba(41, 39, 32, 0.14);
  border-radius: 9px;
  background: #fffaf0;
  color: #292720;
}
'''))

# 7) Tests for the new review/feedback boundary and signed screening metadata.
write('tests/discoveryFeedback.test.ts', r'''
import { describe, expect, it } from 'vitest'
import {
  createDiscoveryFeedbackRecords,
  deriveDiscoveryReviewChangeSet,
  recentRejectedDiscoveryFeedback,
} from '../src/discoveryFeedback.js'
import type { ChangeSetRecord } from '../src/changeSet.js'
import type { Opportunity, TimelineRecord } from '../src/model.js'

function opportunity(id: string, company: string, role: string): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 85,
    fitScore: 78,
    locallyManaged: true,
    importedAt: '2026-09-11T10:00:00.000Z',
    detail: {
      discovery: {
        sourceUrl: `https://careers.example.com/${id}`,
        sourceTitle: `${company} ${role}`,
        rationale: '测试来源证据',
        discoveredAt: '2026-09-11T10:00:00.000Z',
        fitConfidence: 'medium',
        opportunityValueConfidence: 'medium',
      },
    },
  }
}

const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-ROUND3',
  version: 1,
  source: 'mcp',
  status: 'pending',
  title: 'ChatGPT 岗位发现 · 2 个候选',
  createdAt: '2026-09-11T10:00:00.000Z',
  updatedAt: '2026-09-11T10:00:00.000Z',
  operations: [
    { id: 'discovery:add:a', kind: 'add_discovered_opportunity', summary: '新增 A', opportunity: opportunity('a', '甲公司', 'AI 产品经理') },
    { id: 'discovery:add:b', kind: 'add_discovered_opportunity', summary: '新增 B', opportunity: opportunity('b', '乙公司', '商业分析') },
  ],
}

describe('Round 3 discovery review feedback', () => {
  it('derives an auditable subset ChangeSet from the signed discovery operations only', () => {
    const reviewed = deriveDiscoveryReviewChangeSet(changeSet, new Set(['discovery:add:a']))
    expect(reviewed.operations).toHaveLength(1)
    expect(reviewed.operations[0].id).toBe('discovery:add:a')
    expect(reviewed.title).toContain('已选 1/2')
  })

  it('records accepted, rejected, filtered, duplicate and deferred outcomes after explicit review', () => {
    const records = createDiscoveryFeedbackRecords(
      changeSet,
      new Set(['discovery:add:a']),
      { 'discovery:add:b': { code: 'location' } },
      {
        received: 5,
        accepted: 2,
        duplicateCount: 1,
        rejectedCount: 1,
        deferredCount: 1,
        skippedDuplicates: [{ company: '丙公司', role: 'AI 产品经理', reason: '重复' }],
        rejectedCandidates: [{ company: '丁公司', role: '销售', reasons: ['命中排除条件'] }],
        deferredCandidates: [{ company: '戊公司', role: '产品运营', qualityScore: 71, reason: '超过审阅上限' }],
      },
      new Date('2026-09-11T12:00:00.000Z'),
    )
    expect(records.map((item) => item.discoveryDecision)).toEqual([
      'accepted', 'rejected', 'duplicate', 'filtered', 'deferred',
    ])
    expect(records.find((item) => item.discoveryDecision === 'rejected')?.discoveryReasonCode).toBe('location')
  })

  it('treats a later accepted decision as overriding an earlier rejection for rediscovery suppression', () => {
    const timeline: TimelineRecord[] = [
      {
        id: 'r1', kind: 'discovery_rejected', category: 'opportunity', source: 'user_action',
        occurredAt: '2026-09-01T00:00:00.000Z', recordedAt: '2026-09-01T00:00:00.000Z',
        title: '拒绝', company: '甲公司', role: 'AI 产品经理', discoveryDecision: 'rejected',
      },
      {
        id: 'a1', kind: 'discovery_accepted', category: 'opportunity', source: 'user_action',
        occurredAt: '2026-09-05T00:00:00.000Z', recordedAt: '2026-09-05T00:00:00.000Z',
        title: '接受', company: '甲公司', role: 'AI 产品经理', discoveryDecision: 'accepted',
      },
    ]
    expect(recentRejectedDiscoveryFeedback(timeline, new Date('2026-09-11T00:00:00.000Z'))).toHaveLength(0)
  })
})
''')

replace_once(
    'tests/mcpProposal.test.ts',
    "  it('puts an opaque signed token only in the URL fragment', () => {\n",
    "  it('round-trips signed discovery screening diagnostics', () => {\n"
    "    const now = new Date('2026-09-11T02:00:00.000Z')\n"
    "    const discoveryReview = {\n"
    "      received: 3, accepted: 1, duplicateCount: 1, rejectedCount: 1, deferredCount: 0,\n"
    "      skippedDuplicates: [{ company: '甲公司', role: 'AI 产品经理', reason: '重复' }],\n"
    "      rejectedCandidates: [{ company: '乙公司', role: '销售', reasons: ['命中排除'] }],\n"
    "      deferredCandidates: [],\n"
    "    }\n"
    "    const encoded = encodeMcpProposal(createMcpProposalEnvelope(changeSet, 'drive:6', now, discoveryReview))\n"
    "    expect(decodeMcpProposal(encoded).discoveryReview).toEqual(discoveryReview)\n"
    "  })\n\n"
    "  it('puts an opaque signed token only in the URL fragment', () => {\n",
)
replace_once(
    'tests/discoveredOpportunityProposal.test.ts',
    "    expect(envelope.changeSet.expectedWorkspaceFingerprint).toMatch(/^[a-f0-9]{64}$/)\n",
    "    expect(envelope.changeSet.expectedWorkspaceFingerprint).toMatch(/^[a-f0-9]{64}$/)\n"
    "    expect(envelope.discoveryReview).toMatchObject({ received: 1, accepted: 1, duplicateCount: 0, rejectedCount: 0, deferredCount: 0 })\n",
)
replace_once(
    'tests/discoveryQuality.test.ts',
    "  it('deduplicates against existing similar roles and keeps only the strongest bounded review batch', () => {\n",
    "  it('suppresses a highly similar role the user explicitly rejected recently', () => {\n"
    "    const history = [{\n"
    "      id: 'feedback-1',\n"
    "      kind: 'discovery_rejected' as const,\n"
    "      category: 'opportunity' as const,\n"
    "      source: 'user_action' as const,\n"
    "      occurredAt: '2026-09-05T00:00:00.000Z',\n"
    "      recordedAt: '2026-09-05T00:00:00.000Z',\n"
    "      title: '拒绝 AI 发现岗位',\n"
    "      company: '甲公司',\n"
    "      role: '产品经理（AI方向）',\n"
    "      discoveryDecision: 'rejected' as const,\n"
    "    }]\n"
    "    const result = screenDiscoveryCandidates(profile(), [\n"
    "      candidate({ company: '甲公司', role: 'AI 产品经理', sourceTitle: '甲公司 AI PM' }),\n"
    "    ], [], weights, now, history)\n"
    "    expect(result.accepted).toHaveLength(0)\n"
    "    expect(result.rejectedCandidates[0].reasons.join(' ')).toContain('最近 120 天')\n"
    "  })\n\n"
    "  it('deduplicates against existing similar roles and keeps only the strongest bounded review batch', () => {\n",
)

write('docs/V1_3_ROUND_3_DISCOVERY_FEEDBACK.md', r'''
# PJSDAS v1.3 Round 3 — Discovery Review & Feedback Loop

Round 3 turns job discovery from a batch-only import into a user-controlled feedback loop.

## Product boundary

- Opening a signed ChatGPT review link is still non-mutating.
- Each discovered job is selected individually in the review page.
- Only selected jobs enter Opportunities when the user explicitly applies the ChangeSet.
- Unselected jobs are not silently forgotten: after explicit Apply or Discard, PJSDAS records a compact Timeline-backed discovery decision.
- Rejection reasons are explicit user choices, never inferred from chat history.
- Quality-gate diagnostics (duplicate / filtered / deferred) are signed inside the proposal envelope and shown in the review UI.

## Durable feedback

Round 3 stores discovery feedback as Timeline records rather than introducing another database store. This means the feedback automatically participates in the existing local backup, Google Drive snapshot, conflict detection and workspace fingerprint model.

User decisions:

- `discovery_accepted`
- `discovery_rejected`

Quality-gate outcomes:

- `discovery_filtered`
- `discovery_duplicate`
- `discovery_deferred`

A rejection can carry one explicit reason code: location, compensation, role direction, company/opportunity value, requirements mismatch, a better similar role already exists, not interested, or other.

## Rediscovery suppression

`get_discovery_context` now returns a discovery-history summary plus recently rejected identities. The deterministic quality gate also rejects highly similar same-company roles when the latest explicit user decision for that identity is a rejection within the previous 120 days. A later explicit acceptance supersedes an older rejection.

## Partial Apply

The signed proposal still contains the complete accepted review batch. The browser may derive only a strict subset of those already-signed discovery operations after the user checks/unchecks cards. It cannot add arbitrary operations. The derived subset keeps the original workspace baseline and is validated before Apply.

## Screening visibility

The signed proposal carries bounded screening diagnostics:

- number received from ChatGPT search;
- number admitted to review;
- duplicate count and reasons;
- hard-filter count and reasons;
- deferred count, quality scores and reasons.

This allows the review page to explain why a broad web search produced a smaller review set without trusting unsigned browser state.

## Acceptance criteria

1. A two-job discovery ChangeSet can apply only one selected job.
2. The unselected job remains out of Opportunities and records the explicit rejection reason.
3. Discarding an entire discovery batch adds no Opportunities but records explicit rejection feedback.
4. Duplicate / filtered / deferred diagnostics are visible in the review page and persisted after explicit review action.
5. A recently rejected highly similar role is blocked by the quality gate for 120 days unless a later explicit acceptance supersedes it.
6. Existing v1.2 and v1.3 safety properties remain: signed link, 24-hour expiry, exact workspace baseline, no server-side direct Drive write, and no mutation on link open.
''')

# Remove this one-shot implementation machinery from the final branch commit.
for relative in [
    'scripts/round3_codemod.py',
    '.github/workflows/round3-codemod-one-shot.yml',
]:
    target = ROOT / relative
    if target.exists():
        target.unlink()

print('Round 3 codemod applied.')
