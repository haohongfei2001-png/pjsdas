import {
  parseProgressUpdate as parseProgressUpdateV4,
  type ExecutableProgressOperation,
  type ProgressOperation,
  type ProgressUpdatePlan,
  type UnresolvedOperation,
} from './progressUpdateV4.js'
import { detectNotificationType, matchNotificationOpportunity } from './notificationParser.js'
import { jobIdentityKey, jobRoleSimilarity, normalizeJobCompany, normalizeJobRole } from './jobPosting.js'
import {
  defaultMinutesForProcessEvent,
  defaultTimingModeForProcessEvent,
  isActionableProcessEvent,
  stageForProcessEvent,
} from './processEvents.js'
import type { Opportunity, ProcessEventType } from './model.js'

export interface CanonicalJobReference {
  opportunityId: string
  company: string
  role: string
  sourceBacked?: boolean
  sourceLabel?: string
}

const PROCESS_TASK = '(?:测评|笔试|面试|考试|测试)'
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
const COMPANY_SUFFIXES = ['股份有限公司', '有限责任公司', '有限公司', '集团股份', '集团公司', '集团', '汽车', '科技']
const RECRUITING_CUES = /(投递|校招|招聘|岗位|职位|面试|测评|笔试|考试|offer|录用|流程|筛选|招聘官|hr)/i
const NON_JOB_CONTEXT = /(论文|课题|开题|答辩|毕业|导师|课程|作业|稿件|期刊|会议|代码|网页|网站|软件|功能|模型|PAIA|PJSDAS|助学|贷款|奖学金|报销|签证|证件|体检|医院|预约|缴费|租房|快递|生活|学习|研究)/i
const GENERAL_TASK_START = /^(?:(?:事项|待办|其他事项|个人事项|非求职)\s*[:：]|(?:准备|计划|需要|要做|待|处理|办理|修改|整理|更新|检查|测试|开发|修复|写|阅读|看|学习|复习|联系|预约|提交|缴费|打印|购买|配置))/i

function companyIdentityKey(value: string) {
  const normalized = normalizeJobCompany(value)
  const group = COMPANY_ALIAS_GROUPS.find((aliases) => aliases.some((alias) => normalizeJobCompany(alias) === normalized))
  return group ? normalizeJobCompany(group[0]) : normalized
}

function companyAliases(value: string) {
  const aliases = new Set<string>([value.trim()])
  const normalized = normalizeJobCompany(value)
  const group = COMPANY_ALIAS_GROUPS.find((items) => items.some((alias) => normalizeJobCompany(alias) === normalized))
  for (const alias of group ?? []) aliases.add(alias)
  for (const suffix of COMPANY_SUFFIXES) {
    if (value.endsWith(suffix) && value.length - suffix.length >= 2) aliases.add(value.slice(0, -suffix.length).trim())
  }
  return [...aliases].map((alias) => normalizeJobCompany(alias)).filter((alias) => alias.length >= 2)
}

function textMentionsCompany(text: string, company: string) {
  const haystack = normalizeJobCompany(text)
  return companyAliases(company).some((alias) => haystack.includes(alias))
}

function mentionedCompanyOpportunities(text: string, opportunities: Opportunity[]) {
  return opportunities.filter((item) => textMentionsCompany(text, item.company))
}

function explicitProcessCompletion(text: string) {
  if (!new RegExp(PROCESS_TASK, 'i').test(text)) return false
  const completionMetadata = new RegExp(
    `${PROCESS_TASK}.{0,6}(?:已(?:经)?)?完成(?:时间|日期|期限|截止|要求|说明|状态|节点)|(?:完成|做完)${PROCESS_TASK}.{0,6}(?:时间|日期|期限|截止|要求|说明)`,
    'i',
  )
  if (completionMetadata.test(text)) return false
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
    executable: unique.filter((item): item is ExecutableProgressOperation => item.kind !== 'unresolved' && item.kind !== 'ignored'),
    unresolved: unique.filter((item): item is UnresolvedOperation => item.kind === 'unresolved'),
    ignored: unique.filter((item): item is Extract<ProgressOperation, { kind: 'ignored' }> => item.kind === 'ignored'),
  }
}

function repairExplicitCompletions(plan: ProgressUpdatePlan, currentOpportunities: Opportunity[]): ProgressUpdatePlan {
  const operations: ProgressOperation[] = plan.operations.map((operation) => {
    if (operation.kind === 'process_event' && isActionableProcessEvent(operation.eventType) && explicitProcessCompletion(operation.sourceText)) {
      return { ...operation, completed: true, confidence: 'high' }
    }
    if (operation.kind === 'unresolved') return completedEventFromUnresolved(operation, currentOpportunities) ?? operation
    return operation
  })
  return rebuildPlan(operations)
}

function roleEditSimilarity(a: string, b: string) {
  const left = normalizeJobRole(a)
  const right = normalizeJobRole(b)
  if (!left || !right) return 0
  if (left === right) return 1
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = Array<number>(right.length + 1).fill(0)
    current[0] = row
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        (previous[column] ?? column) + 1,
        (current[column - 1] ?? row) + 1,
        (previous[column - 1] ?? column - 1) + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  const distance = previous[right.length] ?? Math.max(left.length, right.length)
  return 1 - distance / Math.max(left.length, right.length)
}

function roleIdentityScore(a: string, b: string) {
  return Math.max(jobRoleSimilarity(a, b), roleEditSimilarity(a, b))
}

function dedupeReferences(references: CanonicalJobReference[]) {
  const byIdentity = new Map<string, CanonicalJobReference>()
  for (const reference of references) {
    const key = `${companyIdentityKey(reference.company)}|${normalizeJobRole(reference.role)}`
    const previous = byIdentity.get(key)
    if (!previous || (!previous.sourceBacked && reference.sourceBacked)) byIdentity.set(key, reference)
  }
  return [...byIdentity.values()]
}

function resolveReferences(company: string, role: string, references: CanonicalJobReference[]) {
  const companyKey = companyIdentityKey(company)
  const candidates = dedupeReferences(references)
    .filter((item) => companyIdentityKey(item.company) === companyKey)
    .map((reference) => ({ reference, score: roleIdentityScore(role, reference.role) }))
    .filter((item) => item.score >= 0.72)
    .sort((a, b) => b.score - a.score || Number(Boolean(b.reference.sourceBacked)) - Number(Boolean(a.reference.sourceBacked)) || a.reference.opportunityId.localeCompare(b.reference.opportunityId))
  if (candidates.length === 0) return { kind: 'none' as const }
  const sourceBacked = candidates.filter((item) => item.reference.sourceBacked && item.score >= 0.78)
  const pool = sourceBacked.length ? sourceBacked : candidates
  if (pool.length === 1 && pool[0]!.score >= 0.78) return { kind: 'match' as const, ...pool[0]! }
  const best = pool[0]!
  const second = pool[1]!
  if (best.score === 1 && second.score < 1) return { kind: 'match' as const, ...best }
  if (best.score >= 0.86 && best.score - second.score >= 0.08) return { kind: 'match' as const, ...best }
  return { kind: 'ambiguous' as const, candidates: pool }
}

function workspaceReferences(currentOpportunities: Opportunity[]): CanonicalJobReference[] {
  return currentOpportunities.map((opportunity) => {
    const discovery = opportunity.detail?.discovery
    const posting = discovery?.posting
    const expectedPostingIdentity = posting
      ? jobIdentityKey(opportunity.company, opportunity.role, discovery?.location)
      : undefined
    const postingBacksCurrentTitle = Boolean(posting && posting.identityKey === expectedPostingIdentity)
    return {
      opportunityId: opportunity.id,
      company: opportunity.company,
      role: opportunity.role,
      sourceBacked: postingBacksCurrentTitle,
      sourceLabel: postingBacksCurrentTitle ? posting?.canonicalSourceUrl ?? posting?.sourceUrl : 'workspace',
    }
  })
}

type IdentityOperation = Extract<ProgressOperation, { kind: 'upsert_opportunity' | 'rename_opportunity' }>

function identityUnresolved(
  operation: IdentityOperation,
  reason: string,
  candidates: Array<{ reference: CanonicalJobReference; score: number }> = [],
): UnresolvedOperation {
  return {
    id: `identity:${operation.id}`,
    kind: 'unresolved',
    sourceText: operation.sourceText,
    confidence: 'low',
    occurredAt: operation.occurredAt,
    reason,
    candidates: candidates.slice(0, 5).map(({ reference, score }) => ({
      id: reference.opportunityId,
      label: `${reference.company}｜${reference.role} · ${Math.round(score * 100)}%`,
    })),
  }
}

/** User-entered role text is an alias; canonical role names come only from source-backed job records. */
function repairOpportunityIdentities(
  plan: ProgressUpdatePlan,
  currentOpportunities: Opportunity[],
  canonicalReferences: CanonicalJobReference[],
): ProgressUpdatePlan {
  const currentReferences = workspaceReferences(currentOpportunities)
  const sourceBackedCurrentReferences = currentReferences.filter((item) => item.sourceBacked)
  const officialReferences = canonicalReferences.map((item) => ({ ...item, sourceBacked: item.sourceBacked ?? true }))
  const operations: ProgressOperation[] = plan.operations.map((operation) => {
    if (operation.kind === 'rename_opportunity') {
      const official = resolveReferences(operation.company, operation.newRole, officialReferences)
      if (official.kind === 'ambiguous') {
        return identityUnresolved(operation, '新岗位名在官网/来源候选中对应多个相近岗位；不会把手写的新名称直接写入主数据。', official.candidates)
      }
      if (official.kind !== 'match') {
        return identityUnresolved(operation, '岗位转变后的新名称没有官网/来源支持；手写新岗位名不能直接成为 canonical title。请先通过岗位发现或官网来源确认目标岗位。')
      }
      const otherCurrentReferences = currentReferences.filter((item) => item.opportunityId !== operation.opportunityId)
      const existingTarget = resolveReferences(official.reference.company, official.reference.role, otherCurrentReferences)
      if (existingTarget.kind === 'ambiguous') {
        return identityUnresolved(operation, '目标 canonical 岗位在当前工作区存在多个可能记录；为避免重复或错误合并，本次不自动改名。', existingTarget.candidates)
      }
      if (existingTarget.kind === 'match') {
        return identityUnresolved(
          operation,
          '岗位转变后的 canonical 岗位已经作为另一个 Opportunity 存在；为避免生成两个相同岗位，本次不自动 rename，需要先合并流程身份。',
          [existingTarget],
        )
      }
      return {
        ...operation,
        company: official.reference.company,
        newRole: official.reference.role,
        confidence: 'high',
      }
    }

    if (operation.kind !== 'upsert_opportunity') return operation
    const existing = resolveReferences(operation.company, operation.role, currentReferences)
    const sourceBackedExisting = resolveReferences(operation.company, operation.role, sourceBackedCurrentReferences)
    const official = resolveReferences(operation.company, operation.role, officialReferences)
    if (official.kind === 'ambiguous') {
      return identityUnresolved(operation, '官网/来源候选中存在多个相近岗位；本次不会用手输简称直接创建或合并。', official.candidates)
    }
    if (official.kind === 'match') {
      const targetFromOfficial = resolveReferences(official.reference.company, official.reference.role, currentReferences)
      if (targetFromOfficial.kind === 'ambiguous') {
        return identityUnresolved(operation, '统一岗位名可以确定，但当前工作区有多个可能对应的 Opportunity；为避免误合并，本次不写入。', targetFromOfficial.candidates)
      }
      const opportunityId = targetFromOfficial.kind === 'match'
        ? targetFromOfficial.reference.opportunityId
        : existing.kind === 'match'
          ? existing.reference.opportunityId
          : official.reference.opportunityId
      return { ...operation, opportunityId, company: official.reference.company, role: official.reference.role, confidence: 'high' }
    }
    if (sourceBackedExisting.kind === 'ambiguous') {
      return identityUnresolved(operation, '检测到多个来源支持的相近现有岗位；为避免错误合并，本次不自动选择。', sourceBackedExisting.candidates)
    }
    if (sourceBackedExisting.kind === 'match') {
      return {
        ...operation,
        opportunityId: sourceBackedExisting.reference.opportunityId,
        company: sourceBackedExisting.reference.company,
        role: sourceBackedExisting.reference.role,
        confidence: 'high',
      }
    }
    if (existing.kind === 'match') {
      return identityUnresolved(
        operation,
        '检测到相似的历史 Opportunity，但当前岗位名没有被同一 Job Posting identity 证明，不能继续充当 canonical 岗位名。请先用岗位发现或官网来源确认统一岗位名；确认后会沿用原 Opportunity ID，而不是创建第二个岗位。',
        [existing],
      )
    }
    if (existing.kind === 'ambiguous') {
      return identityUnresolved(operation, '检测到多个高度相似的历史岗位，且缺少足够来源证据；为避免重复或错误合并，本次不自动新建。', existing.candidates)
    }
    return identityUnresolved(
      operation,
      '未找到官网/来源支持的统一岗位名；手输岗位名只作为别名，不会直接创建第二个 Opportunity。请先让岗位发现/官网来源建立 canonical 岗位。',
    )
  })
  return rebuildPlan(operations)
}

interface CanonicalTarget {
  opportunityId: string
  company: string
  role: string
}

function relinkCanonicalizedOperations(original: ProgressUpdatePlan, canonicalized: ProgressUpdatePlan) {
  const canonicalUpserts = new Map(
    canonicalized.operations
      .filter((item): item is Extract<ProgressOperation, { kind: 'upsert_opportunity' }> => item.kind === 'upsert_opportunity')
      .map((item) => [item.id, item]),
  )
  const remap = new Map<string, CanonicalTarget>()
  for (const operation of original.operations) {
    if (operation.kind !== 'upsert_opportunity') continue
    const canonical = canonicalUpserts.get(operation.id)
    if (!canonical || canonical.opportunityId === operation.opportunityId) continue
    remap.set(operation.opportunityId, {
      opportunityId: canonical.opportunityId,
      company: canonical.company,
      role: canonical.role,
    })
  }
  if (remap.size === 0) return canonicalized

  const operations = canonicalized.operations.map((operation): ProgressOperation => {
    if (operation.kind === 'process_event') {
      const target = remap.get(operation.opportunityId)
      return target ? { ...operation, opportunityId: target.opportunityId, company: target.company, role: target.role } : operation
    }
    if (operation.kind === 'close_opportunity') {
      const target = remap.get(operation.opportunityId)
      return target ? { ...operation, opportunityId: target.opportunityId, company: target.company, role: target.role } : operation
    }
    if (operation.kind === 'rename_opportunity') {
      const target = remap.get(operation.opportunityId)
      return target ? { ...operation, opportunityId: target.opportunityId, company: target.company, oldRole: target.role } : operation
    }
    return operation
  })
  return rebuildPlan(operations)
}

function rememberOpportunity(recentByCompany: Map<string, string>, virtual: Opportunity[], operation: ProgressOperation) {
  if (!['upsert_opportunity', 'close_opportunity', 'rename_opportunity', 'process_event'].includes(operation.kind)) return
  const typed = operation as Extract<ProgressOperation, { kind: 'upsert_opportunity' | 'close_opportunity' | 'rename_opportunity' | 'process_event' }>
  recentByCompany.set(companyIdentityKey(typed.company), typed.opportunityId)
  if (operation.kind === 'upsert_opportunity') {
    const existing = virtual.find((item) => item.id === operation.opportunityId)
    if (existing) {
      existing.company = operation.company
      existing.role = operation.role
      if (operation.mode === 'submitted') existing.processStage = 'screening'
    } else {
      virtual.push({
        id: operation.opportunityId,
        company: operation.company,
        role: operation.role,
        currentStageLabel: operation.mode === 'submitted' ? '筛选中' : '待投',
        processStage: operation.mode === 'submitted' ? 'screening' : 'not_applied',
        roleType: 'core',
        early: false,
        opportunityValue: 80,
        fitScore: 60,
        locallyManaged: true,
        importedAt: operation.occurredAt,
      })
    }
  }
}

function testShorthandTarget(text: string, virtual: Opportunity[], recentByCompany: Map<string, string>) {
  const mentioned = mentionedCompanyOpportunities(text, virtual)
  const companyKeys = [...new Set(mentioned.map((item) => companyIdentityKey(item.company)))]
  if (companyKeys.length !== 1) return { candidates: mentioned }
  const companyKey = companyKeys[0]!
  const sameCompany = virtual.filter((item) => companyIdentityKey(item.company) === companyKey)
  const recentId = recentByCompany.get(companyKey)
  const recent = recentId ? sameCompany.find((item) => item.id === recentId) : undefined
  if (recent) return { target: recent, candidates: sameCompany }
  const assessment = sameCompany.filter((item) => item.processStage === 'assessment')
  if (assessment.length === 1) return { target: assessment[0], candidates: sameCompany }
  const active = sameCompany.filter((item) => item.processStage !== 'closed')
  if (active.length === 1) return { target: active[0], candidates: sameCompany }
  if (sameCompany.length === 1) return { target: sameCompany[0], candidates: sameCompany }
  return { candidates: sameCompany }
}

function repairCompanyTestShorthand(plan: ProgressUpdatePlan, currentOpportunities: Opportunity[]): ProgressUpdatePlan {
  const virtual = currentOpportunities.map((item) => structuredClone(item))
  const recentByCompany = new Map<string, string>()
  const operations: ProgressOperation[] = []
  for (const operation of plan.operations) {
    if (operation.kind !== 'unresolved' || !/测试/.test(operation.sourceText)) {
      operations.push(operation)
      rememberOpportunity(recentByCompany, virtual, operation)
      continue
    }
    const target = testShorthandTarget(operation.sourceText, virtual, recentByCompany)
    if (!target.target) {
      if (target.candidates.length > 0) {
        operations.push({
          ...operation,
          reason: '识别到“公司 + 测试”招聘流程简称，但该公司存在多个可能岗位；没有足够证据时不会猜。',
          candidates: target.candidates.slice(0, 5).map((item) => ({ id: item.id, label: `${item.company}｜${item.role}` })),
        })
      } else operations.push(operation)
      continue
    }
    const event: ExecutableProgressOperation = {
      id: `company-test:${operation.id}`,
      kind: 'process_event',
      sourceText: operation.sourceText,
      confidence: 'high',
      occurredAt: operation.occurredAt,
      opportunityId: target.target.id,
      company: target.target.company,
      role: target.target.role,
      eventType: 'assessment_invite',
      timingMode: defaultTimingModeForProcessEvent('assessment_invite'),
      estimatedMinutes: defaultMinutesForProcessEvent('assessment_invite'),
      completed: explicitProcessCompletion(operation.sourceText),
    }
    operations.push(event)
    rememberOpportunity(recentByCompany, virtual, event)
  }
  return rebuildPlan(operations)
}

function localDay(value: string | Date) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function generalTaskTitle(sourceText: string) {
  return sourceText.replace(/^(?:事项|待办|其他事项|个人事项|非求职)\s*[:：]\s*/i, '').trim()
}

function shouldBecomeGeneralTask(
  operation: Extract<ProgressOperation, { kind: 'unresolved' | 'ignored' }>,
  currentOpportunities: Opportunity[],
  now: Date,
) {
  if (localDay(operation.occurredAt) < localDay(now)) return false
  if (mentionedCompanyOpportunities(operation.sourceText, currentOpportunities).length > 0) return false
  const explicit = /^(?:事项|待办|其他事项|个人事项|非求职)\s*[:：]/i.test(operation.sourceText)
  if (explicit) return true
  if (RECRUITING_CUES.test(operation.sourceText) && !NON_JOB_CONTEXT.test(operation.sourceText)) return false
  return GENERAL_TASK_START.test(operation.sourceText) || (NON_JOB_CONTEXT.test(operation.sourceText) && /^(?:投|申请|做|去|完成|处理|准备|计划)/.test(operation.sourceText))
}

function futureTaskDueAt(occurredAt: string, now: Date) {
  const date = new Date(occurredAt)
  if (localDay(date) <= localDay(now)) return undefined
  date.setHours(23, 59, 59, 0)
  return date.toISOString()
}

function repairGeneralTasks(plan: ProgressUpdatePlan, currentOpportunities: Opportunity[], now: Date): ProgressUpdatePlan {
  const operations: ProgressOperation[] = plan.operations.map((operation) => {
    if (operation.kind !== 'unresolved' && operation.kind !== 'ignored') return operation
    if (!shouldBecomeGeneralTask(operation, currentOpportunities, now)) return operation
    return {
      id: `general-task:${operation.id}`,
      kind: 'manual_action',
      sourceText: operation.sourceText,
      confidence: /^(?:事项|待办|其他事项|个人事项|非求职)\s*[:：]/i.test(operation.sourceText) ? 'high' : 'medium',
      occurredAt: operation.occurredAt,
      title: generalTaskTitle(operation.sourceText),
      dueAt: futureTaskDueAt(operation.occurredAt, now),
      estimatedMinutes: 30,
    }
  })
  return rebuildPlan(operations)
}

export function parseProgressUpdate(
  rawText: string,
  currentOpportunities: Opportunity[],
  now = new Date(),
  canonicalReferences: CanonicalJobReference[] = [],
): ProgressUpdatePlan {
  const original = parseProgressUpdateV4(rawText, currentOpportunities, now)
  const identities = repairOpportunityIdentities(original, currentOpportunities, canonicalReferences)
  const relinked = relinkCanonicalizedOperations(original, identities)
  const shorthand = repairCompanyTestShorthand(relinked, currentOpportunities)
  const completed = repairExplicitCompletions(shorthand, currentOpportunities)
  return repairGeneralTasks(completed, currentOpportunities, now)
}
