import {
  detectNotificationType,
  matchNotificationOpportunity,
  parseRecruitingNotification,
} from './notificationParser'
import {
  defaultMinutesForProcessEvent,
  defaultTimingModeForProcessEvent,
} from './processEvents'
import type {
  ActionTimingMode,
  Opportunity,
  ProcessEventType,
  ProcessStage,
} from './model'

export type UpdateConfidence = 'high' | 'medium' | 'low'

interface OperationBase {
  id: string
  sourceText: string
  confidence: UpdateConfidence
  occurredAt: string
}

export interface UpsertOpportunityOperation extends OperationBase {
  kind: 'upsert_opportunity'
  mode: 'planned' | 'submitted'
  opportunityId: string
  company: string
  role: string
}

export interface CloseOpportunityOperation extends OperationBase {
  kind: 'close_opportunity'
  opportunityId: string
  company: string
  role: string
}

export interface RenameOpportunityOperation extends OperationBase {
  kind: 'rename_opportunity'
  opportunityId: string
  company: string
  oldRole: string
  newRole: string
}

export interface ProcessEventOperation extends OperationBase {
  kind: 'process_event'
  opportunityId: string
  company: string
  role: string
  eventType: ProcessEventType
  dueAt?: string
  timingMode?: ActionTimingMode
  estimatedMinutes: number
  completed?: boolean
}

export interface ManualActionOperation extends OperationBase {
  kind: 'manual_action'
  title: string
  dueAt?: string
  estimatedMinutes: number
}

export interface UnresolvedOperation extends OperationBase {
  kind: 'unresolved'
  reason: string
  candidates?: Array<{ id: string; label: string }>
}

export interface IgnoredOperation extends OperationBase {
  kind: 'ignored'
  reason: string
}

export type ProgressOperation =
  | UpsertOpportunityOperation
  | CloseOpportunityOperation
  | RenameOpportunityOperation
  | ProcessEventOperation
  | ManualActionOperation
  | UnresolvedOperation
  | IgnoredOperation

export type ExecutableProgressOperation = Exclude<ProgressOperation, UnresolvedOperation | IgnoredOperation>

export interface ProgressUpdatePlan {
  operations: ProgressOperation[]
  executable: ExecutableProgressOperation[]
  unresolved: UnresolvedOperation[]
  ignored: IgnoredOperation[]
}

const DAY = 86_400_000
const HOUR = 3_600_000

const COMPANY_SUFFIXES = [
  '股份有限公司',
  '有限责任公司',
  '有限公司',
  '集团股份',
  '集团',
  '银行',
  '汽车',
  '证券',
  '保险',
  '咨询',
  '电子',
  '科技',
  '国际',
  '机器人',
]

// These aliases are brand names commonly used in campus recruiting text. They
// are intentionally small and generic; the current local Opportunity list is
// still the primary source of company identity.
const BRAND_ALIAS_GROUPS = [
  ['拼多多', 'PDD'],
  ['阿里巴巴', '阿里'],
  ['京东', 'JD'],
  ['小鹏汽车', '小鹏集团', '小鹏', 'XPeng'],
  ['长鑫存储', '长鑫科技', '长鑫', 'CXMT'],
  ['中芯国际', '中芯', 'SMIC'],
  ['Roland Berger', '罗兰贝格'],
  ['ZS Associates', 'ZS'],
]

const ROLE_ANCHORS = [
  'AI全栈产品研发培训生',
  'AI产品经理培训生',
  'AI产品经理',
  '用户产品经理',
  '技术产品经理',
  '产品管培生',
  '运营管培生',
  '管理培训生',
  '项目管理管培生',
  '产品经理',
  'PMO经理',
  '战略分析师',
  '战略分析',
  '商业分析师',
  '商业分析',
  'Junior Consultant',
  '项目管理',
  '产品运营',
  '解决方案',
  '工程师',
  '顾问',
  '管培生',
]

const ROLE_WORDS = /(经理|管培|培训生|分析|工程师|顾问|咨询|运营|产品|PMO|项目|战略|研发|供应链|销售|职能)/i

function compact(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}

function simpleHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function operationId(kind: string, source: string, suffix = '') {
  return `nl:${kind}:${simpleHash(`${source}|${suffix}`)}`
}

function localOpportunityId(company: string, role: string) {
  return `local:${simpleHash(`${compact(company)}|${compact(role)}`)}`
}

function brandAliases(company: string) {
  const key = compact(company)
  return BRAND_ALIAS_GROUPS.find((group) =>
    group.some((alias) => {
      const aliasKey = compact(alias)
      return key === aliasKey || key.includes(aliasKey) || aliasKey.includes(key)
    }),
  ) ?? []
}

function companyAliases(company: string) {
  const aliases = new Set<string>([company.trim(), ...brandAliases(company)])
  let short = company.trim()
  for (const suffix of COMPANY_SUFFIXES) {
    if (short.endsWith(suffix) && short.length - suffix.length >= 2) {
      short = short.slice(0, -suffix.length)
      aliases.add(short)
    }
  }

  const latinWords = company.match(/[A-Za-z][A-Za-z0-9&.'-]*/g) ?? []
  const firstLatinWord = latinWords[0]
  if (firstLatinWord && firstLatinWord.length >= 2) aliases.add(firstLatinWord)
  if (latinWords.length >= 2) {
    const acronym = latinWords.map((word) => word[0]).join('')
    if (acronym.length >= 2) aliases.add(acronym)
  }
  return [...aliases].filter((item) => compact(item).length >= 2)
}

function sameCompany(a: string, b: string) {
  const aa = companyAliases(a).map(compact)
  const bb = companyAliases(b).map(compact)
  return aa.some((left) => bb.some((right) => left === right || left.includes(right) || right.includes(left)))
}

interface CompanyMatch {
  company: string
  alias: string
}

function findKnownCompanyMatch(text: string, opportunities: Opportunity[]): CompanyMatch | undefined {
  const haystack = compact(text)
  const matches = [...new Set(opportunities.map((item) => item.company))]
    .flatMap((company) => companyAliases(company).map((alias) => ({ company, alias })))
    .filter(({ alias }) => haystack.includes(compact(alias)))
    .sort((a, b) => compact(b.alias).length - compact(a.alias).length)
  return matches[0]
}

function removeMatchedCompanyPrefix(text: string, match: CompanyMatch) {
  const aliases = [match.alias, ...companyAliases(match.company)]
    .sort((a, b) => b.length - a.length)
  let result = text.trim()
  for (const alias of aliases) {
    const index = compact(result).startsWith(compact(alias)) ? result.toLowerCase().indexOf(alias.toLowerCase()) : -1
    if (index === 0) {
      result = result.slice(alias.length).trim()
      break
    }
  }
  return result.replace(/^(?:集团|科技|汽车)\s*/i, '').trim()
}

function splitByRoleAnchor(text: string) {
  const lower = text.toLowerCase()
  let best: { index: number; anchor: string } | undefined
  for (const anchor of ROLE_ANCHORS) {
    const index = lower.indexOf(anchor.toLowerCase())
    if (index <= 0) continue
    if (!best || index < best.index || (index === best.index && anchor.length > best.anchor.length)) {
      best = { index, anchor }
    }
  }
  if (!best) return undefined
  const company = text.slice(0, best.index).trim().replace(/[：:｜|]+$/, '')
  const role = text.slice(best.index).trim()
  if (company.length < 2 || role.length < 2) return undefined
  return { company, roleText: role }
}

function inferCompanyAndRole(text: string, opportunities: Opportunity[]) {
  const raw = text.trim().replace(/^[：:｜|]+|[，,。]+$/g, '')
  const known = findKnownCompanyMatch(raw, opportunities)
  if (known) {
    const roleText = removeMatchedCompanyPrefix(raw, known)
    if (roleText.length >= 2) return { company: known.company, roleText }
  }

  const explicit = raw.split(/[｜|:：]/).map((item) => item.trim()).filter(Boolean)
  if (explicit.length >= 2) return { company: explicit[0], roleText: explicit.slice(1).join('｜') }

  const latinCompany = raw.match(/^([A-Za-z][A-Za-z0-9& .'-]{1,35})([\u4e00-\u9fff].+)$/)
  if (latinCompany?.[1] && latinCompany[2]) {
    return { company: latinCompany[1].trim(), roleText: latinCompany[2].trim() }
  }

  const suffixMatch = raw.match(/^(.{2,24}?(?:银行|集团|公司|汽车|证券|保险|咨询|电子|科技|国际|机器人))(.+)$/)
  if (suffixMatch?.[1] && suffixMatch[2] && ROLE_WORDS.test(suffixMatch[2])) {
    return { company: suffixMatch[1].trim(), roleText: suffixMatch[2].trim() }
  }

  return splitByRoleAnchor(raw)
}

function roleList(raw: string) {
  const cleaned = raw.trim().replace(/[，,]+$/, '')

  const intentCenters = cleaned.match(/^(.*?)([^和、，,]{2,12}中心)和([^和、，,]{2,12}中心)(?:两个)?意向$/)
  if (intentCenters?.[1] && intentCenters[2] && intentCenters[3]) {
    const base = intentCenters[1].trim()
    return [`${base}${intentCenters[2]}`.trim(), `${base}${intentCenters[3]}`.trim()]
  }

  const ideographic = cleaned.split(/、/).map((item) => item.trim()).filter(Boolean)
  if (ideographic.length > 1) return ideographic

  const andParts = cleaned.split(/和/).map((item) => item.trim()).filter(Boolean)
  if (andParts.length > 1 && andParts.slice(1).every((item) => ROLE_WORDS.test(item))) return andParts
  return [cleaned]
}

function applicationParts(sourceText: string) {
  const standard = sourceText.match(/(准备投递|计划投递|准备申请|投递|申请)(.+)/)
  if (standard) return { verb: standard[1], tail: standard[2].trim() }
  const short = sourceText.match(/^投(.+)/)
  if (short) return { verb: '投', tail: short[1].trim() }
  return undefined
}

interface TimelineClause {
  text: string
  baseDate: Date
  explicitDate: boolean
}

function receivePrefix(text: string) {
  const match = text.match(/((?:上午|早上|下午|晚上|晚间)?\s*\d{1,2}(?:\s*[:：]\s*\d{2}|\s*点(?:\s*\d{1,2}\s*分?)?)\s*(?:收到|接到))\s*[:：]?/)
  return match?.[1]?.trim()
}

function splitInput(raw: string, now: Date): TimelineClause[] {
  const rows: TimelineClause[] = []
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const dateMatch = line.match(/^(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日[，,\s]*/)
    let baseDate = new Date(now)
    let explicitDate = false
    let content = line
    if (dateMatch) {
      explicitDate = true
      baseDate = new Date(
        Number(dateMatch[1] ?? now.getFullYear()),
        Number(dateMatch[2]) - 1,
        Number(dateMatch[3]),
        12,
        0,
        0,
        0,
      )
      content = line.slice(dateMatch[0].length)
    }

    const normalized = content
      .replace(/，(?=(?:准备投递|计划投递|准备申请|投递|申请|投(?=[A-Za-z\u4e00-\u9fa5])))/g, '。')
      .replace(/，(?=[^，。]{1,45}?(?:(?:岗位)?(?:转变为|转为|改为|更名为|变为)|流程(?:结束|终止|开启|重启|开始|关闭)))/g, '。')

    let carriedReceive = ''
    for (const piece of normalized.split(/[。；;]+/)) {
      let text = piece.trim().replace(/^[，,]+|[，,]+$/g, '')
      if (!text) continue
      const ownPrefix = receivePrefix(text)
      if (ownPrefix) carriedReceive = ownPrefix
      else if (carriedReceive && /(测评|笔试|面试|考试)/.test(text) && !/(收到|接到)/.test(text)) {
        text = `${carriedReceive}，${text}`
      }
      rows.push({ text, baseDate: new Date(baseDate), explicitDate })
    }
  }
  return rows
}

function receiveTime(text: string) {
  const match = text.match(/(?:上午|早上|下午|晚上|晚间)?\s*(\d{1,2})(?:\s*[:：]\s*(\d{2})|\s*点\s*(?:(\d{1,2})\s*分?)?)\s*(?:收到|接到)/)
  if (!match) return undefined
  const source = match[0]
  let hour = Number(match[1])
  const minute = Number(match[2] ?? match[3] ?? 0)
  if (/(下午|晚上|晚间)/.test(source) && hour < 12) hour += 12
  if (/(上午|早上)/.test(source) && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return undefined
  return { hour, minute }
}

function occurredAtFor(text: string, baseDate: Date, now: Date) {
  const result = new Date(baseDate)
  const received = receiveTime(text)
  if (received) {
    result.setHours(received.hour, received.minute, 0, 0)
    return result
  }
  const sameDay = result.getFullYear() === now.getFullYear() &&
    result.getMonth() === now.getMonth() &&
    result.getDate() === now.getDate()
  if (sameDay) result.setHours(now.getHours(), now.getMinutes(), 0, 0)
  else result.setHours(12, 0, 0, 0)
  return result
}

function relativeDueAt(text: string, occurredAt: Date) {
  const hours = text.match(/(\d+(?:\.\d+)?)\s*小时(?:内)?(?:完成|截止|有效)?/)
  if (hours) return new Date(occurredAt.getTime() + Number(hours[1]) * HOUR).toISOString()
  const days = text.match(/(\d+(?:\.\d+)?)\s*(?:天|日)(?:内)?(?:完成|截止|有效)?/)
  if (days) return new Date(occurredAt.getTime() + Number(days[1]) * DAY).toISOString()
  return undefined
}

function contextWithDate(text: string, baseDate: Date, explicitDate: boolean) {
  if (!explicitDate) return text
  return `${baseDate.getFullYear()}年${baseDate.getMonth() + 1}月${baseDate.getDate()}日 ${text}`
}

function isPastLocalDay(baseDate: Date, now: Date) {
  const a = new Date(baseDate)
  const b = new Date(now)
  a.setHours(0, 0, 0, 0)
  b.setHours(0, 0, 0, 0)
  return a.getTime() < b.getTime()
}

function historicalBareEvent(text: string, baseDate: Date, explicitDate: boolean, now: Date) {
  if (!explicitDate || !isPastLocalDay(baseDate, now)) return false
  return !/(收到|接到|通知|邀请|安排|将于|请于|请在|截止|最晚|小时|日内|天内|前完成)/.test(text)
}

function stageForEvent(type: ProcessEventType): ProcessStage | undefined {
  if (type === 'assessment_invite') return 'assessment'
  if (type === 'written_test_invite') return 'written_test'
  if (type === 'interview_invite') return 'interview'
  if (type === 'offer') return 'offer'
  if (type === 'rejection') return 'closed'
  return undefined
}

function extractRoleHint(text: string, companyMatch: CompanyMatch) {
  let context = text
  const aliases = [companyMatch.alias, ...companyAliases(companyMatch.company)]
    .sort((a, b) => b.length - a.length)
  for (const alias of aliases) context = context.replace(new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '')
  context = context
    .replace(/^(?:上午|早上|下午|晚上|晚间)?\s*\d{1,2}(?::\d{2}|点(?:\d{1,2}分?)?)?\s*(?:收到|接到)?\s*[:：，,]*/, '')
    .trim()
  return context
    .split(/(?:流程|测评|笔试|面试|考试|收到|接到|通知|邀请|截止|开启|重启|开始|结束|终止|关闭|转为|转变为|改为|更名为|变为)/)[0]
    .replace(/^(?:集团|科技|汽车|岗位)/, '')
    .trim()
}

function roleMatchScore(hint: string, role: string) {
  const h = compact(hint)
  const r = compact(role)
  if (!h || !r) return 0
  if (h === r) return 100
  if (r.includes(h) || h.includes(r)) return Math.min(95, 60 + Math.min(h.length, r.length) * 3)

  const tokens = ['ai', '产品', '运营', '战略', '分析', '管培', '培训生', '项目', '管理', '研发', '技术', '用户', 'pm', 'pmo', '顾问', '咨询']
  const shared = tokens.filter((token) => h.includes(compact(token)) && r.includes(compact(token))).length
  return shared * 14
}

function touchRecent(recentByCompany: Map<string, string>, company: string, opportunityId: string) {
  const key = compact(companyAliases(company)[0] ?? company)
  const previous = recentByCompany.get(key)
  if (previous === undefined || previous === opportunityId) recentByCompany.set(key, opportunityId)
  else recentByCompany.set(key, '')
}

function recentForCompany(recentByCompany: Map<string, string>, company: string) {
  for (const alias of companyAliases(company)) {
    const id = recentByCompany.get(compact(alias))
    if (id !== undefined) return id
  }
  return undefined
}

function targetFor(
  text: string,
  opportunities: Opportunity[],
  recentByCompany: Map<string, string>,
  eventType?: ProcessEventType,
) {
  const direct = matchNotificationOpportunity(text, opportunities)
  if (direct.selected) {
    return { opportunity: direct.selected, confidence: direct.confidence as UpdateConfidence, candidates: direct.candidates }
  }

  const companyMatch = findKnownCompanyMatch(text, opportunities)
  if (!companyMatch) return { confidence: 'low' as UpdateConfidence, candidates: direct.candidates }
  const same = opportunities.filter((item) => sameCompany(item.company, companyMatch.company))

  const roleHint = extractRoleHint(text, companyMatch)
  if (compact(roleHint).length >= 2) {
    const scored = same
      .map((opportunity) => ({ opportunity, score: roleMatchScore(roleHint, opportunity.role) }))
      .filter((item) => item.score >= 45)
      .sort((a, b) => b.score - a.score)
    if (scored.length === 1 || (scored[0] && scored[1] && scored[0].score - scored[1].score >= 18)) {
      return { opportunity: scored[0].opportunity, confidence: scored[0].score >= 80 ? 'high' as const : 'medium' as const, candidates: direct.candidates }
    }
  }

  const recentId = recentForCompany(recentByCompany, companyMatch.company)
  const recent = recentId ? same.find((item) => item.id === recentId) : undefined
  if (recent) return { opportunity: recent, confidence: 'medium' as const, candidates: direct.candidates }

  const desiredStage = eventType ? stageForEvent(eventType) : undefined
  if (desiredStage) {
    const stageMatches = same.filter((item) => item.processStage === desiredStage)
    if (stageMatches.length === 1) {
      return { opportunity: stageMatches[0], confidence: 'medium' as const, candidates: direct.candidates }
    }
  }

  const active = same.filter((item) => item.processStage !== 'closed')
  if (active.length === 1) return { opportunity: active[0], confidence: 'medium' as const, candidates: direct.candidates }
  if (same.length === 1) return { opportunity: same[0], confidence: 'medium' as const, candidates: direct.candidates }

  return {
    confidence: 'low' as const,
    candidates: direct.candidates.length
      ? direct.candidates
      : same.map((opportunity) => ({ opportunity, score: 1, reasons: [] })),
  }
}

function unresolved(
  sourceText: string,
  occurredAt: Date,
  reason: string,
  candidates: Opportunity[] = [],
): UnresolvedOperation {
  return {
    id: operationId('unresolved', sourceText, reason),
    kind: 'unresolved',
    sourceText,
    confidence: 'low',
    occurredAt: occurredAt.toISOString(),
    reason,
    candidates: candidates.slice(0, 5).map((item) => ({ id: item.id, label: `${item.company}｜${item.role}` })),
  }
}

function ignored(sourceText: string, occurredAt: Date, reason: string): IgnoredOperation {
  return {
    id: operationId('ignored', sourceText, reason),
    kind: 'ignored',
    sourceText,
    confidence: 'high',
    occurredAt: occurredAt.toISOString(),
    reason,
  }
}

function clearlyNonRecruitingHistory(text: string) {
  return /(简历|作品集|个人项目|archive项目|论文|研究项目|项目开发|项目上线)/i.test(text) &&
    !/(投递|申请|流程|测评|笔试|面试|offer|录用)/i.test(text)
}

function virtualOpportunity(
  id: string,
  company: string,
  role: string,
  submitted: boolean,
  occurredAt: Date,
): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: submitted ? '筛选中' : '待投',
    processStage: submitted ? 'screening' : 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 86,
    fitScore: 60,
    locallyManaged: true,
    importedAt: occurredAt.toISOString(),
  }
}

function existingForCompanyRole(opportunities: Opportunity[], company: string, role: string) {
  const roleKey = compact(role)
  return opportunities.find((item) =>
    sameCompany(item.company, company) &&
    (compact(item.role) === roleKey || compact(item.role).includes(roleKey) || roleKey.includes(compact(item.role))),
  )
}

export function parseProgressUpdate(
  rawText: string,
  currentOpportunities: Opportunity[],
  now = new Date(),
): ProgressUpdatePlan {
  const operations: ProgressOperation[] = []
  const virtual = currentOpportunities.map((item) => ({ ...item }))
  const recentByCompany = new Map<string, string>()

  for (const row of splitInput(rawText, now)) {
    const sourceText = row.text
    const occurredAt = occurredAtFor(sourceText, row.baseDate, now)
    const before = operations.length

    const renameMatch = sourceText.match(/(.+?)(?:岗位)?(?:转变为|转为|改为|更名为|变为)([^，,。；;]+)/)
    if (renameMatch) {
      const target = targetFor(renameMatch[1], virtual, recentByCompany)
      const newRole = renameMatch[2].split(/(?:同时|并且|并|且)/)[0].trim()
      if (!target.opportunity || !newRole) {
        operations.push(unresolved(
          sourceText,
          occurredAt,
          '岗位改名存在歧义，需要写明原岗位或更完整的公司/岗位名称。',
          target.candidates?.map((item) => item.opportunity) ?? [],
        ))
      } else {
        operations.push({
          id: operationId('rename', sourceText, target.opportunity.id),
          kind: 'rename_opportunity',
          sourceText,
          confidence: target.confidence,
          occurredAt: occurredAt.toISOString(),
          opportunityId: target.opportunity.id,
          company: target.opportunity.company,
          oldRole: target.opportunity.role,
          newRole,
        })
        target.opportunity.role = newRole
        target.opportunity.locallyManaged = true
        touchRecent(recentByCompany, target.opportunity.company, target.opportunity.id)
      }
    }

    const closeLike = /(流程(?:结束|终止)|终止流程|结束流程|流程关闭)/.test(sourceText)
    if (closeLike) {
      const target = targetFor(sourceText, virtual, recentByCompany, 'rejection')
      if (!target.opportunity) {
        operations.push(unresolved(
          sourceText,
          occurredAt,
          '无法唯一确定需要结束的岗位。',
          target.candidates?.map((item) => item.opportunity) ?? [],
        ))
      } else {
        operations.push({
          id: operationId('close', sourceText, target.opportunity.id),
          kind: 'close_opportunity',
          sourceText,
          confidence: target.confidence,
          occurredAt: occurredAt.toISOString(),
          opportunityId: target.opportunity.id,
          company: target.opportunity.company,
          role: target.opportunity.role,
        })
        target.opportunity.processStage = 'closed'
        target.opportunity.currentStageLabel = '流程结束'
        target.opportunity.locallyManaged = true
        touchRecent(recentByCompany, target.opportunity.company, target.opportunity.id)
      }
    }

    const reopenLike = /(流程(?:开启|重启|开始)|开启流程|重启流程)/.test(sourceText)
    if (reopenLike && !closeLike) {
      const target = targetFor(sourceText, virtual, recentByCompany)
      if (!target.opportunity) {
        operations.push(unresolved(
          sourceText,
          occurredAt,
          '无法唯一确定需要开启或重启的岗位流程。',
          target.candidates?.map((item) => item.opportunity) ?? [],
        ))
      } else {
        operations.push({
          id: operationId('reopen', sourceText, target.opportunity.id),
          kind: 'upsert_opportunity',
          sourceText,
          confidence: target.confidence,
          occurredAt: occurredAt.toISOString(),
          mode: 'submitted',
          opportunityId: target.opportunity.id,
          company: target.opportunity.company,
          role: target.opportunity.role,
        })
        target.opportunity.processStage = 'screening'
        target.opportunity.currentStageLabel = '筛选中'
        target.opportunity.locallyManaged = true
        touchRecent(recentByCompany, target.opportunity.company, target.opportunity.id)
      }
    }

    const application = applicationParts(sourceText)
    if (application && !closeLike && !reopenLike) {
      const inferred = inferCompanyAndRole(application.tail, virtual)
      if (!inferred) {
        operations.push(unresolved(sourceText, occurredAt, '无法可靠拆分公司与岗位；可以补一个“公司｜岗位”分隔符。'))
      } else {
        for (const role of roleList(inferred.roleText)) {
          if (!role || role.length < 2) continue
          const submitted = application.verb === '投递' || application.verb === '申请' || application.verb === '投'
          const existing = existingForCompanyRole(virtual, inferred.company, role)
          const opportunityId = existing?.id ?? localOpportunityId(inferred.company, role)
          operations.push({
            id: operationId('opportunity', sourceText, `${opportunityId}|${role}`),
            kind: 'upsert_opportunity',
            sourceText,
            confidence: existing ? 'high' : 'medium',
            occurredAt: occurredAt.toISOString(),
            mode: submitted ? 'submitted' : 'planned',
            opportunityId,
            company: inferred.company,
            role,
          })
          if (existing) {
            existing.locallyManaged = true
            if (submitted) {
              existing.processStage = 'screening'
              existing.currentStageLabel = '筛选中'
            }
          } else {
            virtual.push(virtualOpportunity(opportunityId, inferred.company, role, submitted, occurredAt))
          }
          touchRecent(recentByCompany, inferred.company, opportunityId)
        }
      }
    }

    const relativeDue = relativeDueAt(sourceText, occurredAt)
    let detected = detectNotificationType(sourceText)
    if (relativeDue && /测评/.test(sourceText)) detected = { type: 'assessment_invite', confidence: 'high' }
    const eventLike = detected.type && detected.type !== 'other' && detected.type !== 'status_update'

    if (eventLike && !closeLike) {
      const target = targetFor(sourceText, virtual, recentByCompany, detected.type)
      if (!target.opportunity) {
        operations.push(unresolved(
          sourceText,
          occurredAt,
          '识别到招聘流程事件，但无法唯一确定对应岗位。',
          target.candidates?.map((item) => item.opportunity) ?? [],
        ))
      } else {
        const contextual = contextWithDate(sourceText, row.baseDate, row.explicitDate)
        const parsed = parseRecruitingNotification(contextual, [target.opportunity], occurredAt)
        const completed = historicalBareEvent(sourceText, row.baseDate, row.explicitDate, now)
        const timingMode: ActionTimingMode | undefined = relativeDue
          ? 'deadline'
          : parsed.timingMode ?? defaultTimingModeForProcessEvent(detected.type!)
        const dueAt = relativeDue ?? parsed.dueAt
        const actionable = ['assessment_invite', 'written_test_invite', 'interview_invite'].includes(detected.type!)

        if (actionable && !dueAt && !completed) {
          operations.push(unresolved(sourceText, occurredAt, '流程任务缺少可确认的截止时间或固定发生时间。', [target.opportunity]))
        } else {
          operations.push({
            id: operationId('event', sourceText, `${target.opportunity.id}|${detected.type}|${dueAt ?? ''}|${completed}`),
            kind: 'process_event',
            sourceText,
            confidence: completed || (target.confidence === 'high' && parsed.confidence.time !== 'low') ? 'high' : 'medium',
            occurredAt: occurredAt.toISOString(),
            opportunityId: target.opportunity.id,
            company: target.opportunity.company,
            role: target.opportunity.role,
            eventType: detected.type!,
            dueAt,
            timingMode,
            estimatedMinutes: parsed.estimatedMinutes ?? defaultMinutesForProcessEvent(detected.type!),
            completed,
          })
          touchRecent(recentByCompany, target.opportunity.company, target.opportunity.id)
        }
      }
    }

    if (!renameMatch && !closeLike && !reopenLike && !application && !eventLike) {
      const plannedTask = sourceText.match(/^(?:准备|计划|需要|要做)\s*(.+)/)
      if (plannedTask?.[1] && !clearlyNonRecruitingHistory(sourceText)) {
        operations.push({
          id: operationId('action', sourceText),
          kind: 'manual_action',
          sourceText,
          confidence: 'medium',
          occurredAt: occurredAt.toISOString(),
          title: plannedTask[1].trim(),
          dueAt: row.explicitDate
            ? new Date(row.baseDate.getFullYear(), row.baseDate.getMonth(), row.baseDate.getDate(), 23, 59, 59).toISOString()
            : undefined,
          estimatedMinutes: 30,
        })
      }
    }

    if (operations.length === before) {
      if (clearlyNonRecruitingHistory(sourceText)) {
        operations.push(ignored(sourceText, occurredAt, '这是求职背景/项目历程，不会改动岗位、流程或 Today。'))
      } else {
        operations.push(unresolved(
          sourceText,
          occurredAt,
          '这条文字没有被可靠识别为岗位、流程事件或待办，因此没有自动修改数据。',
        ))
      }
    }
  }

  const unique = [...new Map(operations.map((item) => [item.id, item])).values()]
  const unresolvedItems = unique.filter((item): item is UnresolvedOperation => item.kind === 'unresolved')
  const ignoredItems = unique.filter((item): item is IgnoredOperation => item.kind === 'ignored')
  const executableItems = unique.filter(
    (item): item is ExecutableProgressOperation => item.kind !== 'unresolved' && item.kind !== 'ignored',
  )
  return {
    operations: unique,
    executable: executableItems,
    unresolved: unresolvedItems,
    ignored: ignoredItems,
  }
}

export function progressOperationSummary(operation: ProgressOperation) {
  switch (operation.kind) {
    case 'upsert_opportunity':
      return `${operation.mode === 'submitted' ? '已投递/流程开启' : '计划投递'}：${operation.company}｜${operation.role}`
    case 'close_opportunity':
      return `结束流程：${operation.company}｜${operation.role}`
    case 'rename_opportunity':
      return `修改岗位：${operation.company}｜${operation.oldRole} → ${operation.newRole}`
    case 'process_event': {
      const labels: Record<ProcessEventType, string> = {
        assessment_invite: '测评',
        written_test_invite: '笔试',
        interview_invite: '面试',
        offer: 'Offer',
        rejection: '流程结束',
        status_update: '状态更新',
        other: '其他进展',
      }
      return `流程事件：${operation.company}｜${operation.role} · ${labels[operation.eventType]}${operation.completed ? ' · 已完成' : ''}${operation.dueAt ? ` · ${new Date(operation.dueAt).toLocaleString('zh-CN')}` : ''}`
    }
    case 'manual_action':
      return `新增待办：${operation.title}`
    case 'ignored':
      return `无需写入：${operation.reason}`
    case 'unresolved':
      return `待确认：${operation.reason}`
  }
}
