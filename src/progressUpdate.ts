import {
  parseProgressUpdate as parseProgressUpdateV4,
  type ExecutableProgressOperation,
  type ProgressOperation,
  type ProgressUpdatePlan,
  type UnresolvedOperation,
} from './progressUpdateV4.js'
import { detectNotificationType, matchNotificationOpportunity } from './notificationParser.js'
import { jobRoleSimilarity, normalizeJobCompany } from './jobPosting.js'
import {
  defaultMinutesForProcessEvent,
  defaultTimingModeForProcessEvent,
  isActionableProcessEvent,
  stageForProcessEvent,
} from './processEvents.js'
import type { Opportunity, ProcessEventType } from './model.js'

export * from './progressUpdateV4.js'

const PROCESS_TASK = '(?:测评|笔试|面试|考试)'
const COMPANY_ALIAS_GROUPS = [
  ['京东', '京东集团', 'JD', 'JDS', 'JD.COM'],
  ['拼多多', 'PDD', 'PDD Holdings'],
  ['阿里巴巴', '阿里', 'Alibaba'],
  ['小鹏汽车', '小鹏集团', '小鹏', 'XPeng'],
  ['长鑫存储', '长鑫科技', '长鑫', 'CXMT'],
  ['中芯国际', '中芯', 'SMIC'],
  ['Roland Berger', '罗兰贝格'],
  ['ZS Associates', 'ZS'],
] as const

function companyIdentityKey(value: string) {
  const normalized = normalizeJobCompany(value)
  const group = COMPANY_ALIAS_GROUPS.find((aliases) => aliases.some((alias) => normalizeJobCompany(alias) === normalized))
  return group ? normalizeJobCompany(group[0]) : normalized
}

function explicitProcessCompletion(text: string) {
  if (!new RegExp(PROCESS_TASK, 'i').test(text)) return false

  // “测评完成时间/日期/期限…” describes metadata about a task, not a report
  // that the user has actually completed it.
  const completionMetadata = new RegExp(
    `${PROCESS_TASK}.{0,6}(?:已(?:经)?)?完成(?:时间|日期|期限|截止|要求|说明|状态|节点)|(?:完成|做完)${PROCESS_TASK}.{0,6}(?:时间|日期|期限|截止|要求|说明)`,
    'i',
  )
  if (completionMetadata.test(text)) return false

  // Do not mistake an instruction/deadline containing “完成” for a report that
  // the user has actually finished the task.
  const pendingInstruction = new RegExp(
    `(?:请|需|需要|须|务必|应当|待).{0,16}(?:完成|做完|参加).{0,10}${PROCESS_TASK}|(?:截止|最晚|(?:小时|天|日)内|前).{0,16}(?:完成|做完)`,
    'i',
  )
  const strongCompletion = new RegExp(
    `(?:已(?:经)?|刚刚?|刚).{0,6}(?:完成|做完|考完|面完|参加完)(?:了)?.{0,8}${PROCESS_TASK}|${PROCESS_TASK}.{0,6}(?:已(?:经)?)?(?:完成(?:了)?|做完(?:了)?|结束(?:了)?|完毕|考完(?:了)?|面完(?:了)?)|(?:完成了|做完了|考完了|面完了|参加完了).{0,8}${PROCESS_TASK}`,
    'i',
  )

  if (pendingInstruction.test(text)) return false
  if (strongCompletion.test(text)) return true

  // “测评完成 / 笔试结束” are concise status statements; unlike
  // “48 小时内完成测评”, the task noun appears first with no instruction cue.
  return new RegExp(`${PROCESS_TASK}\s*(?:完成|结束)$`, 'i').test(text.trim())
}

function targetForExplicitCompletion(
  operation: UnresolvedOperation,
  currentOpportunities: Opportunity[],
  type: ProcessEventType,
) {
  const direct = matchNotificationOpportunity(operation.sourceText, currentOpportunities)
  if (direct.selected) return direct.selected

  const candidateIds = new Set(operation.candidates?.map((item) => item.id) ?? [])
  const candidates = candidateIds.size
    ? currentOpportunities.filter((item) => candidateIds.has(item.id))
    : []
  if (candidates.length === 1) return candidates[0]

  const desiredStage = stageForProcessEvent(type)
  if (desiredStage) {
    const stageMatches = candidates.filter((item) => item.processStage === desiredStage)
    if (stageMatches.length === 1) return stageMatches[0]
  }
  return undefined
}

function completedEventFromUnresolved(
  operation: UnresolvedOperation,
  currentOpportunities: Opportunity[],
): ExecutableProgressOperation | undefined {
  if (!explicitProcessCompletion(operation.sourceText)) return undefined
  const detected = detectNotificationType(operation.sourceText)
  if (!detected.type || !isActionableProcessEvent(detected.type)) return undefined
  const target = targetForExplicitCompletion(operation, currentOpportunities, detected.type)
  if (!target) return undefined

  return {
    id: `completed:${operation.id}`,
    kind: 'process_event',
    sourceText: operation.sourceText,
    confidence: 'high',
    occurredAt: operation.occurredAt,
    opportunityId: target.id,
    company: target.company,
    role: target.role,
    eventType: detected.type,
    timingMode: defaultTimingModeForProcessEvent(detected.type),
    estimatedMinutes: defaultMinutesForProcessEvent(detected.type),
    completed: true,
  }
}

function rebuildPlan(operations: ProgressOperation[]): ProgressUpdatePlan {
  const unique = [...new Map(operations.map((item) => [item.id, item])).values()]
  return {
    operations: unique,
    executable: unique.filter(
      (item): item is ExecutableProgressOperation => item.kind !== 'unresolved' && item.kind !== 'ignored',
    ),
    unresolved: unique.filter((item): item is UnresolvedOperation => item.kind === 'unresolved'),
    ignored: unique.filter((item): item is Extract<ProgressOperation, { kind: 'ignored' }> => item.kind === 'ignored'),
  }
}

function repairExplicitCompletions(
  plan: ProgressUpdatePlan,
  currentOpportunities: Opportunity[],
): ProgressUpdatePlan {
  const operations: ProgressOperation[] = plan.operations.map((operation) => {
    if (operation.kind === 'process_event' &&
      isActionableProcessEvent(operation.eventType) &&
      explicitProcessCompletion(operation.sourceText)) {
      return { ...operation, completed: true, confidence: 'high' }
    }
    if (operation.kind === 'unresolved') {
      return completedEventFromUnresolved(operation, currentOpportunities) ?? operation
    }
    return operation
  })
  return rebuildPlan(operations)
}

function resolveExistingOpportunity(
  company: string,
  role: string,
  currentOpportunities: Opportunity[],
) {
  const companyKey = companyIdentityKey(company)
  const candidates = currentOpportunities
    .filter((item) => companyIdentityKey(item.company) === companyKey)
    .map((opportunity) => ({ opportunity, score: jobRoleSimilarity(role, opportunity.role) }))
    .filter((item) => item.score >= 0.84)
    .sort((a, b) => b.score - a.score || a.opportunity.id.localeCompare(b.opportunity.id))

  if (candidates.length === 0) return { kind: 'none' as const }
  if (candidates.length === 1) return { kind: 'match' as const, ...candidates[0] }

  const [best, second] = candidates
  if (best.score === 1 && second.score < 1) return { kind: 'match' as const, ...best }
  if (best.score >= 0.92 && best.score - second.score >= 0.12) {
    return { kind: 'match' as const, ...best }
  }
  return { kind: 'ambiguous' as const, candidates }
}

/**
 * Final identity guard for user-entered opportunities.
 *
 * Earlier parser versions already catch many exact/substring matches, but those
 * parsers can also choose the first substring match when one company has several
 * similar roles. Re-evaluate every upsert here. Reuse an existing Opportunity
 * only when company identity agrees and the role match is unique/high-confidence.
 * Ambiguity is surfaced instead of silently creating another logical job or
 * merging two distinct roles.
 */
function repairOpportunityIdentities(
  plan: ProgressUpdatePlan,
  currentOpportunities: Opportunity[],
): ProgressUpdatePlan {
  const operations: ProgressOperation[] = plan.operations.map((operation) => {
    if (operation.kind !== 'upsert_opportunity') return operation

    const resolved = resolveExistingOpportunity(operation.company, operation.role, currentOpportunities)
    if (resolved.kind === 'none') return operation
    if (resolved.kind === 'match') {
      return {
        ...operation,
        opportunityId: resolved.opportunity.id,
        company: resolved.opportunity.company,
        role: resolved.opportunity.role,
        confidence: 'high',
      }
    }

    return {
      id: `identity:${operation.id}`,
      kind: 'unresolved',
      sourceText: operation.sourceText,
      confidence: 'low',
      occurredAt: operation.occurredAt,
      reason: '检测到多个高度相似的现有岗位；为避免重复或错误合并，本次不自动新建。',
      candidates: resolved.candidates.slice(0, 5).map(({ opportunity, score }) => ({
        id: opportunity.id,
        label: `${opportunity.company}｜${opportunity.role} · ${Math.round(score * 100)}%`,
      })),
    }
  })
  return rebuildPlan(operations)
}

export function parseProgressUpdate(
  rawText: string,
  currentOpportunities: Opportunity[],
  now = new Date(),
): ProgressUpdatePlan {
  const completed = repairExplicitCompletions(
    parseProgressUpdateV4(rawText, currentOpportunities, now),
    currentOpportunities,
  )
  return repairOpportunityIdentities(completed, currentOpportunities)
}
