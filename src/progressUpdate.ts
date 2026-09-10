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

export type ProgressOperation =
  | UpsertOpportunityOperation
  | CloseOpportunityOperation
  | RenameOpportunityOperation
  | ProcessEventOperation
  | ManualActionOperation
  | UnresolvedOperation

export interface ProgressUpdatePlan {
  operations: ProgressOperation[]
  executable: ProgressOperation[]
  unresolved: UnresolvedOperation[]
}

const DAY = 86_400_000
const HOUR = 3_600_000
const roleWords = /(经理|管培|培训生|分析|工程师|顾问|咨询|运营|产品|PMO|项目|战略|研发|供应链|销售|职能)/i
const companySuffixes = ['股份有限公司', '有限责任公司', '有限公司', '集团股份', '集团', '科技']

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

function companyAliases(company: string) {
  const aliases = new Set<string>([company.trim()])
  let short = company.trim()
  for (const suffix of companySuffixes) {
    if (short.endsWith(suffix) && short.length - suffix.length >= 2) {
      short = short.slice(0, -suffix.length)
      aliases.add(short)
    }
  }
  return [...aliases].filter(Boolean)
}

function sameCompany(a: string, b: string) {
  const aa = companyAliases(a).map(compact)
  const bb = companyAliases(b).map(compact)
  return aa.some((left) => bb.some((right) => left === right || left.includes(right) || right.includes(left)))
}

function findKnownCompany(text: string, opportunities: Opportunity[]) {
  const haystack = compact(text)
  const matches = [...new Set(opportunities.map((item) => item.company))]
    .flatMap((company) => companyAliases(company).map((alias) => ({ company, alias })))
    .filter(({ alias }) => compact(alias).length >= 2 && haystack.includes(compact(alias)))
    .sort((a, b) => compact(b.alias).length - compact(a.alias).length)
  return matches[0]?.company
}

function inferCompanyAndRole(text: string, opportunities: Opportunity[]) {
  const known = findKnownCompany(text, opportunities)
  if (known) return { company: known, roleText: stripCompanyPrefix(text, known) }

  const explicit = text.split(/[｜|]/).map((item) => item.trim()).filter(Boolean)
  if (explicit.length >= 2) return { company: explicit[0], roleText: explicit.slice(1).join('｜') }

  const patterned = text.match(/^(.{2,18}?(?:公司|集团|银行|汽车|证券|保险|咨询|电子|科技|国际|机器人))(.+)$/)
  if (patterned?.[1] && patterned[2]) return { company: patterned[1].trim(), roleText: patterned[2].trim() }
  return undefined
}

function splitInput(raw: string, now: Date) {
  const rows: Array<{ text: string; baseDate: Date; explicitDate: boolean }> = []

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const dateMatch = line.match(/^(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日[，,\s]*/)
    let baseDate = new Date(now)
    let explicitDate = false
    let content = line

    if (dateMatch) {
      explicitDate = true
      const year = Number(dateMatch[1] ?? now.getFullYear())
      baseDate = new Date(year, Number(dateMatch[2]) - 1, Number(dateMatch[3]), 12, 0, 0, 0)
      content = line.slice(dateMatch[0].length)
    }

    const normalized = content.replace(
      /，(?=(?:准备投递|计划投递|准备申请|投递|申请|投(?=[A-Za-z\u4e00-\u9fa5])))/g,
      '。',
    )

    for (const piece of normalized.split(/[。；;]+/)) {
      const text = piece.trim().replace(/^[，,]+|[，,]+$/g, '')
      if (text) rows.push({ text, baseDate: new Date(baseDate), explicitDate })
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

function roleList(raw: string) {
  const cleaned = raw.trim().replace(/[，,]+$/, '')
  const ideographic = cleaned.split(/、/).map((item) => item.trim()).filter(Boolean)
  if (ideographic.length > 1) return ideographic

  const andParts = cleaned.split(/和/).map((item) => item.trim()).filter(Boolean)
  if (andParts.length > 1 && andParts.slice(1).every((item) => roleWords.test(item))) return andParts
  return [cleaned]
}

function stripCompanyPrefix(raw: string, company: string) {
  const aliases = companyAliases(company).sort((a, b) => b.length - a.length)
  const trimmed = raw.trim()
  for (const alias of aliases) {
    if (trimmed.startsWith(alias)) return trimmed.slice(alias.length).trim()
  }
  return trimmed
}

function touchRecent(recentByCompany: Map<string, string>, company: string, opportunityId: string) {
  const key = compact(company)
  const previous = recentByCompany.get(key)
  if (previous === undefined || previous === opportunityId) recentByCompany.set(key, opportunityId)
  else recentByCompany.set(key, '')
}

function targetFor(
  text: string,
  opportunities: Opportunity[],
  recentByCompany: Map<string, string>,
) {
  const direct = matchNotificationOpportunity(text, opportunities)
  if (direct.selected) {
    return { opportunity: direct.selected, confidence: direct.confidence as UpdateConfidence, candidates: direct.candidates }
  }

  const company = findKnownCompany(text, opportunities)
  if (!company) return { confidence: 'low' as UpdateConfidence, candidates: direct.candidates }
  const same = opportunities.filter((item) => sameCompany(item.company, company))
  const recentId = recentByCompany.get(compact(company))
  const recent = recentId ? same.find((item) => item.id === recentId) : undefined
  if (recent) return { opportunity: recent, confidence: 'medium' as UpdateConfidence, candidates: direct.candidates }

  const active = same.filter((item) => item.processStage !== 'closed')
  if (active.length === 1) return { opportunity: active[0], confidence: 'medium' as UpdateConfidence, candidates: direct.candidates }
  if (same.length === 1) return { opportunity: same[0], confidence: 'medium' as UpdateConfidence, candidates: direct.candidates }
  return {
    confidence: 'low' as UpdateConfidence,
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

function applicationParts(sourceText: string) {
  const standard = sourceText.match(/(准备投递|计划投递|准备申请|投递|申请)(.+)/)
  if (standard) return { verb: standard[1], tail: standard[2].trim() }
  const short = sourceText.match(/^投(.+)/)
  if (short) return { verb: '投', tail: short[1].trim() }
  return undefined
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
      const target = targetFor(sourceText, virtual, recentByCompany)
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

    const application = applicationParts(sourceText)
    if (application && !closeLike) {
      const inferred = inferCompanyAndRole(application.tail, virtual)
      if (!inferred) {
        operations.push(unresolved(sourceText, occurredAt, '无法可靠拆分公司与岗位；请写成“投递 公司｜岗位”。'))
      } else {
        const roles = roleList(inferred.roleText)
        for (const role of roles) {
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
    if (relativeDue && /测评/.test(sourceText)) {
      detected = { type: 'assessment_invite', confidence: 'high' }
    }
    const eventLike = detected.type && detected.type !== 'other' && detected.type !== 'status_update'
    if (eventLike && !closeLike) {
      const target = targetFor(sourceText, virtual, recentByCompany)
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
        const timingMode: ActionTimingMode | undefined = relativeDue
          ? 'deadline'
          : parsed.timingMode ?? defaultTimingModeForProcessEvent(detected.type!)
        const dueAt = relativeDue ?? parsed.dueAt
        const actionable = ['assessment_invite', 'written_test_invite', 'interview_invite'].includes(detected.type!)

        if (actionable && !dueAt) {
          operations.push(unresolved(sourceText, occurredAt, '流程任务缺少可确认的截止时间或固定发生时间。', [target.opportunity]))
        } else {
          operations.push({
            id: operationId('event', sourceText, `${target.opportunity.id}|${detected.type}|${dueAt ?? ''}`),
            kind: 'process_event',
            sourceText,
            confidence: target.confidence === 'high' && parsed.confidence.time !== 'low' ? 'high' : 'medium',
            occurredAt: occurredAt.toISOString(),
            opportunityId: target.opportunity.id,
            company: target.opportunity.company,
            role: target.opportunity.role,
            eventType: detected.type!,
            dueAt,
            timingMode,
            estimatedMinutes: defaultMinutesForProcessEvent(detected.type!),
          })
          touchRecent(recentByCompany, target.opportunity.company, target.opportunity.id)
        }
      }
    }

    if (!renameMatch && !closeLike && !application && !eventLike) {
      const plannedTask = sourceText.match(/^(?:准备|计划|需要|要做)\s*(.+)/)
      if (plannedTask?.[1]) {
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
  }

  const unique = [...new Map(operations.map((item) => [item.id, item])).values()]
  const unresolvedItems = unique.filter((item): item is UnresolvedOperation => item.kind === 'unresolved')
  return {
    operations: unique,
    executable: unique.filter((item) => item.kind !== 'unresolved'),
    unresolved: unresolvedItems,
  }
}

export function progressOperationSummary(operation: ProgressOperation) {
  switch (operation.kind) {
    case 'upsert_opportunity':
      return `${operation.mode === 'submitted' ? '已投递' : '计划投递'}：${operation.company}｜${operation.role}`
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
      return `流程事件：${operation.company}｜${operation.role} · ${labels[operation.eventType]}${operation.dueAt ? ` · ${new Date(operation.dueAt).toLocaleString('zh-CN')}` : ''}`
    }
    case 'manual_action':
      return `新增待办：${operation.title}`
    case 'unresolved':
      return `待确认：${operation.reason}`
  }
}
