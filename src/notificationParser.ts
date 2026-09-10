import {
  defaultMinutesForProcessEvent,
  defaultTimingModeForProcessEvent,
} from './processEvents'
import type {
  ActionTimingMode,
  Opportunity,
  ProcessEventType,
} from './model'

export interface OpportunityCandidate {
  opportunity: Opportunity
  score: number
  reasons: string[]
}

export interface NotificationParseResult {
  opportunity?: Opportunity
  candidates: OpportunityCandidate[]
  type?: ProcessEventType
  timingMode?: ActionTimingMode
  occurredAt: string
  dueAt?: string
  estimatedMinutes?: number
  confidence: {
    opportunity: 'high' | 'medium' | 'low'
    type: 'high' | 'medium' | 'low'
    time: 'high' | 'medium' | 'low'
  }
  warnings: string[]
}

const companySuffixes = [
  '股份有限公司',
  '有限责任公司',
  '有限公司',
  '集团股份',
  '集团',
  '科技',
]

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}

function companyAliases(company: string) {
  const raw = normalize(company)
  const aliases = new Set<string>([raw])
  let short = raw
  for (const suffix of companySuffixes) {
    const normalizedSuffix = normalize(suffix)
    if (short.endsWith(normalizedSuffix) && short.length - normalizedSuffix.length >= 2) {
      short = short.slice(0, -normalizedSuffix.length)
      aliases.add(short)
    }
  }
  return [...aliases].filter((item) => item.length >= 2)
}

function roleAliases(role: string) {
  const raw = normalize(role)
  const aliases = new Set<string>([raw])
  for (const part of role.split(/[\/｜|、，,；;]/)) {
    const normalizedPart = normalize(part)
    if (normalizedPart.length >= 2) aliases.add(normalizedPart)
  }
  return [...aliases]
}

export function matchNotificationOpportunity(
  text: string,
  opportunities: Opportunity[],
): { selected?: Opportunity; candidates: OpportunityCandidate[]; confidence: 'high' | 'medium' | 'low' } {
  const haystack = normalize(text)
  const scored = opportunities
    .map((opportunity): OpportunityCandidate => {
      let score = 0
      const reasons: string[] = []
      const companies = companyAliases(opportunity.company)
      const roles = roleAliases(opportunity.role)
      const fullCompany = companies[0]

      if (fullCompany && haystack.includes(fullCompany)) {
        score += 70
        reasons.push('完整公司名命中')
      } else {
        const shortCompany = companies
          .slice(1)
          .sort((a, b) => b.length - a.length)
          .find((alias) => haystack.includes(alias))
        if (shortCompany) {
          score += Math.min(58, 38 + shortCompany.length * 3)
          reasons.push('公司简称命中')
        }
      }

      const fullRole = roles[0]
      if (fullRole && fullRole.length >= 3 && haystack.includes(fullRole)) {
        score += 34
        reasons.push('完整岗位名命中')
      } else {
        const rolePart = roles
          .slice(1)
          .sort((a, b) => b.length - a.length)
          .find((alias) => alias.length >= 3 && haystack.includes(alias))
        if (rolePart) {
          score += 22
          reasons.push('岗位关键词命中')
        }
      }

      return { opportunity, score, reasons }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (a.opportunity.order ?? 9999) - (b.opportunity.order ?? 9999))
    .slice(0, 5)

  const first = scored[0]
  const second = scored[1]
  if (!first || first.score < 40) return { candidates: scored, confidence: 'low' }

  const margin = first.score - (second?.score ?? 0)
  const sameCompanyAmbiguity = second &&
    normalize(second.opportunity.company) === normalize(first.opportunity.company) &&
    margin < 20

  if (first.score >= 85 && margin >= 18 && !sameCompanyAmbiguity) {
    return { selected: first.opportunity, candidates: scored, confidence: 'high' }
  }
  if (first.score >= 60 && margin >= 12 && !sameCompanyAmbiguity) {
    return { selected: first.opportunity, candidates: scored, confidence: 'medium' }
  }
  return { candidates: scored, confidence: 'low' }
}

export function detectNotificationType(text: string): { type?: ProcessEventType; confidence: 'high' | 'medium' | 'low' } {
  const normalized = normalize(text)

  if (
    /(未通过|很遗憾|流程结束|终止流程|暂不匹配)/.test(text) ||
    /感谢.*(?:参与|申请|投递).*?(?:遗憾|未能|不匹配)/.test(text)
  ) {
    return { type: 'rejection', confidence: 'high' }
  }
  if (/(offer|录用通知|拟录用|录取通知)/i.test(text)) {
    return { type: 'offer', confidence: 'high' }
  }
  if (/(面试|ai面|一面|二面|三面|终面|视频面|业务面|hr面)/i.test(text)) {
    return { type: 'interview_invite', confidence: 'high' }
  }
  if (/(笔试|在线考试|统一考试|机考|开考)/.test(text)) {
    return { type: 'written_test_invite', confidence: 'high' }
  }
  if (/(测评|人才测评|性格测试|在线测试|综合测评)/.test(text)) {
    return { type: 'assessment_invite', confidence: 'high' }
  }
  if (/(状态更新|流程更新|进度更新)/.test(text)) {
    return { type: 'status_update', confidence: 'medium' }
  }
  if (normalized.length > 0) return { type: 'other', confidence: 'low' }
  return { confidence: 'low' }
}

function detectTimingMode(text: string, type?: ProcessEventType): ActionTimingMode | undefined {
  if (!type || !['assessment_invite', 'written_test_invite', 'interview_invite'].includes(type)) return undefined
  if (type === 'interview_invite') return 'fixed'
  if (/(截止|最晚|前完成|之前完成|有效期至|有效期到|失效|链接.*失效|请在.*前|请于.*前)/.test(text)) return 'deadline'
  if (/(固定时间|考试时间|笔试时间|开考|准时参加|场次|统一笔试|统一考试)/.test(text)) return 'fixed'
  return defaultTimingModeForProcessEvent(type)
}

interface DateParts {
  year: number
  month: number
  day: number
}

function datePartsFromText(text: string, now: Date): DateParts | undefined {
  if (/后天/.test(text)) {
    const date = new Date(now)
    date.setDate(date.getDate() + 2)
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
  }
  if (/明天|明日/.test(text)) {
    const date = new Date(now)
    date.setDate(date.getDate() + 1)
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
  }
  if (/今天|今日/.test(text)) {
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
  }

  const fullChinese = text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (fullChinese) {
    return { year: Number(fullChinese[1]), month: Number(fullChinese[2]), day: Number(fullChinese[3]) }
  }

  const shortChinese = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)
  if (shortChinese) {
    const month = Number(shortChinese[1])
    const day = Number(shortChinese[2])
    let year = now.getFullYear()
    const candidate = new Date(year, month - 1, day, 23, 59, 59)
    if (candidate.getTime() < now.getTime() - 45 * DAY) year += 1
    return { year, month, day }
  }

  const numeric = text.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (numeric) {
    return { year: Number(numeric[1]), month: Number(numeric[2]), day: Number(numeric[3]) }
  }

  return undefined
}

const DAY = 86_400_000

function timePartsFromText(text: string) {
  const colon = text.match(/(?:上午|早上|下午|晚上|晚间)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/)
  const chinese = text.match(/(?:上午|早上|下午|晚上|晚间)?\s*(\d{1,2})\s*[点时](?:(\d{1,2})\s*分?)?/)
  const match = colon ?? chinese
  if (!match) return undefined

  let hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  const prefixSource = text.slice(Math.max(0, (match.index ?? 0) - 4), (match.index ?? 0) + match[0].length)
  const pm = /(下午|晚上|晚间)/.test(prefixSource)
  const am = /(上午|早上)/.test(prefixSource)

  if (pm && hour < 12) hour += 12
  if (am && hour === 12) hour = 0
  if (hour > 24 || minute > 59) return undefined
  return { hour, minute }
}

function extractDueAt(
  text: string,
  timingMode: ActionTimingMode | undefined,
  now: Date,
): { dueAt?: string; confidence: 'high' | 'medium' | 'low'; warnings: string[] } {
  const warnings: string[] = []
  const date = datePartsFromText(text, now)
  const time = timePartsFromText(text)

  if (!date && !time) return { confidence: 'low', warnings }

  if (!date && time) {
    warnings.push('只识别到时间，暂按今天处理；保存前请确认日期。')
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hour, time.minute, 0, 0)
    if (time.hour === 24) target.setDate(target.getDate() + 1)
    return { dueAt: target.toISOString(), confidence: 'low', warnings }
  }

  if (date && !time) {
    if (timingMode === 'fixed') {
      warnings.push('识别到日期但没有具体时刻；固定笔试/面试需要补充时间。')
      return { confidence: 'medium', warnings }
    }
    const target = new Date(date.year, date.month - 1, date.day, 23, 59, 59, 0)
    return { dueAt: target.toISOString(), confidence: 'medium', warnings }
  }

  if (!date || !time) return { confidence: 'low', warnings }
  const target = new Date(date.year, date.month - 1, date.day, time.hour === 24 ? 0 : time.hour, time.minute, 0, 0)
  if (time.hour === 24) target.setDate(target.getDate() + 1)
  return { dueAt: target.toISOString(), confidence: 'high', warnings }
}

function estimatedMinutesFromText(text: string, type?: ProcessEventType) {
  if (!type) return undefined

  const range = text.match(/(\d{1,3})\s*[-–—~～至到]\s*(\d{1,3})\s*分钟/)
  if (range?.[1] && range[2]) {
    const upper = Math.max(Number(range[1]), Number(range[2]))
    if (upper >= 5 && upper <= 360) return upper
  }

  const single = text.match(/(?:约|大约|预计|作答时间约)?\s*(\d{1,3})\s*分钟/)
  if (single?.[1]) {
    const minutes = Number(single[1])
    if (minutes >= 5 && minutes <= 360) return minutes
  }

  return defaultMinutesForProcessEvent(type)
}

export function parseRecruitingNotification(
  rawText: string,
  opportunities: Opportunity[],
  now = new Date(),
): NotificationParseResult {
  const text = rawText.trim()
  const opportunityMatch = matchNotificationOpportunity(text, opportunities)
  const typeMatch = detectNotificationType(text)
  const timingMode = detectTimingMode(text, typeMatch.type)
  const timeResult = extractDueAt(text, timingMode, now)
  const warnings = [...timeResult.warnings]

  if (!opportunityMatch.selected) {
    warnings.push(opportunityMatch.candidates.length > 0
      ? '识别到可能的岗位，但存在歧义，需要手动确认。'
      : '没有可靠识别到对应岗位，需要手动选择。')
  }
  if (!typeMatch.type || typeMatch.confidence === 'low') {
    warnings.push('事件类型识别置信度低，需要手动确认。')
  }
  if (
    typeMatch.type &&
    ['assessment_invite', 'written_test_invite', 'interview_invite'].includes(typeMatch.type) &&
    !timeResult.dueAt
  ) {
    warnings.push('该流程事件需要真实截止或固定发生时间。')
  }

  return {
    opportunity: opportunityMatch.selected,
    candidates: opportunityMatch.candidates,
    type: typeMatch.type,
    timingMode,
    occurredAt: now.toISOString(),
    dueAt: timeResult.dueAt,
    estimatedMinutes: estimatedMinutesFromText(text, typeMatch.type),
    confidence: {
      opportunity: opportunityMatch.confidence,
      type: typeMatch.confidence,
      time: timeResult.confidence,
    },
    warnings,
  }
}
