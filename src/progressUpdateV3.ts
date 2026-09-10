import {
  parseProgressUpdate as parseV2,
  progressOperationSummary,
  type CloseOpportunityOperation,
  type ExecutableProgressOperation,
  type IgnoredOperation,
  type ManualActionOperation,
  type ProcessEventOperation,
  type ProgressOperation,
  type ProgressUpdatePlan,
  type UnresolvedOperation,
  type UpsertOpportunityOperation,
  type UpdateConfidence,
} from './progressUpdateV2'
import { detectNotificationType } from './notificationParser'
import {
  defaultMinutesForProcessEvent,
  defaultTimingModeForProcessEvent,
} from './processEvents'
import type { ActionTimingMode, Opportunity, ProcessEventType, ProcessStage } from './model'

export { progressOperationSummary }
export type {
  CloseOpportunityOperation,
  ExecutableProgressOperation,
  IgnoredOperation,
  ManualActionOperation,
  ProcessEventOperation,
  ProgressOperation,
  ProgressUpdatePlan,
  UnresolvedOperation,
  UpsertOpportunityOperation,
  UpdateConfidence,
}

const HOUR = 3_600_000
const DAY = 86_400_000
const ROLE_WORDS = /(经理|管培|培训生|分析|工程师|顾问|咨询|运营|产品|PMO|项目|战略|研发|供应链|销售|职能)/i
const ROLE_ANCHORS = [
  '新品研发项目管理管培生',
  'AI全栈产品研发培训生',
  'AI产品经理培训生',
  '技术产品经理',
  '用户产品经理',
  'AI产品经理',
  '运营管培生',
  '产品管培生',
  '管理培训生',
  '项目管理管培生',
  '产学研合作工程师',
  '战略分析师',
  '战略分析',
  '商业分析师',
  '商业分析',
  'Junior Consultant',
  '产品经理',
  'PMO经理',
  '项目管理',
  '工程师',
  '管培生',
]

const BRAND_GROUPS = [
  ['拼多多', 'PDD'],
  ['阿里巴巴', '阿里'],
  ['京东', 'JD'],
  ['小鹏汽车', '小鹏集团', '小鹏', 'XPeng'],
  ['长鑫存储', '长鑫科技', '长鑫', 'CXMT'],
  ['中芯国际', '中芯', 'SMIC'],
  ['Roland Berger', '罗兰贝格'],
  ['ZS Associates', 'ZS'],
]

function compact(value: string) {
  return value.toLowerCase().replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function operationId(kind: string, source: string, suffix = '') {
  return `nl3:${kind}:${hash(`${source}|${suffix}`)}`
}

function localOpportunityId(company: string, role: string) {
  return `local:${hash(`${compact(company)}|${compact(role)}`)}`
}

function brandGroup(company: string) {
  const key = compact(company)
  return BRAND_GROUPS.find((group) => group.some((alias) => compact(alias) === key))
    ?? BRAND_GROUPS.find((group) => group.some((alias) => compact(alias).length >= 4 && key.includes(compact(alias))))
    ?? []
}

function safeCompanyAliases(company: string) {
  const aliases = new Set<string>([company.trim(), ...brandGroup(company)])
  const visible = company.split(/[（(]/)[0]?.trim()
  if (visible) aliases.add(visible)
  for (const suffix of ['股份有限公司', '有限责任公司', '有限公司', '集团']) {
    if (company.endsWith(suffix)) {
      const short = company.slice(0, -suffix.length).trim()
      if (short.length >= 2) aliases.add(short)
    }
  }
  const latinWords = company.match(/[A-Za-z][A-Za-z0-9&.'-]*/g) ?? []
  if (latinWords.length >= 2) aliases.add(latinWords.slice(0, 2).join(' '))
  else if (latinWords[0] && latinWords[0].length >= 3) aliases.add(latinWords[0])
  return [...aliases].filter((item) => compact(item).length >= 2)
}

function sameCompany(a: string, b: string) {
  const aa = safeCompanyAliases(a).map(compact)
  const bb = safeCompanyAliases(b).map(compact)
  return aa.some((left) => bb.includes(left))
}

function normalizeNewCompany(company: string) {
  return company
    .replace(/^[：:｜|]+|[：:｜|]+$/g, '')
    .replace(/[（(][^）)]*(?:\d{2}届|ASP|校招|校园|提前批)[^）)]*[）)]\s*$/i, '')
    .trim()
}

function earliestRoleAnchor(text: string) {
  const lower = text.toLowerCase()
  let best: { index: number; anchor: string } | undefined
  for (const anchor of ROLE_ANCHORS) {
    const index = lower.indexOf(anchor.toLowerCase())
    if (index <= 0) continue
    if (!best || index < best.index || (index === best.index && anchor.length > best.anchor.length)) {
      best = { index, anchor }
    }
  }
  return best
}

function companyMention(text: string, opportunities: Opportunity[]) {
  const matches = [...new Set(opportunities.map((item) => item.company))]
    .flatMap((company) => safeCompanyAliases(company).map((alias) => ({ company, alias, index: text.toLowerCase().indexOf(alias.toLowerCase()) })))
    .filter((item) => item.index >= 0)
    .sort((a, b) => b.alias.length - a.alias.length || a.index - b.index)
  return matches[0]
}

function splitRoles(raw: string) {
  const cleaned = raw.trim().replace(/^[：:｜|]+|[，,。]+$/g, '')
  const centers = cleaned.match(/^(.*?)([^和、，,]{2,12}中心)和([^和、，,]{2,12}中心)(?:两个)?意向$/)
  if (centers?.[1] && centers[2] && centers[3]) {
    const base = centers[1].trim()
    return [`${base}${centers[2]}`.trim(), `${base}${centers[3]}`.trim()]
  }
  const ideographic = cleaned.split(/、/).map((item) => item.trim()).filter(Boolean)
  if (ideographic.length > 1) return ideographic
  const andParts = cleaned.split(/和/).map((item) => item.trim()).filter(Boolean)
  if (andParts.length > 1 && andParts.slice(1).every((item) => ROLE_WORDS.test(item))) return andParts
  return cleaned ? [cleaned] : []
}

function applicationParts(source: string) {
  const standard = source.match(/(准备投递|计划投递|准备申请|投递|申请)(.+)/)
  if (standard?.[1] && standard[2]) return { verb: standard[1], tail: standard[2].trim() }
  const short = source.match(/^投(.+)/)
  if (short?.[1]) return { verb: '投', tail: short[1].trim() }
  return undefined
}

function inferApplication(source: string, virtual: Opportunity[], occurredAt: string): UpsertOpportunityOperation[] | undefined {
  const application = applicationParts(source)
  if (!application) return undefined
  const mention = companyMention(application.tail, virtual)
  let company: string
  let roleText: string

  if (mention) {
    company = mention.company
    roleText = application.tail.slice(mention.index + mention.alias.length).replace(/^[：:｜|]+/, '').trim()
  } else {
    const anchor = earliestRoleAnchor(application.tail)
    if (!anchor) return undefined
    company = normalizeNewCompany(application.tail.slice(0, anchor.index))
    roleText = application.tail.slice(anchor.index).trim()
  }

  if (company.length < 2 || roleText.length < 2) return undefined
  const submitted = application.verb === '投递' || application.verb === '申请' || application.verb === '投'
  const roles = splitRoles(roleText)
  if (roles.length === 0) return undefined

  return roles.map((role) => {
    const existing = virtual.find((item) =>
      sameCompany(item.company, company) &&
      (compact(item.role) === compact(role) || compact(item.role).includes(compact(role)) || compact(role).includes(compact(item.role))),
    )
    return {
      id: operationId('opportunity', source, `${existing?.id ?? company}|${role}`),
      kind: 'upsert_opportunity',
      sourceText: source,
      confidence: existing ? 'high' : 'medium',
      occurredAt,
      mode: submitted ? 'submitted' : 'planned',
      opportunityId: existing?.id ?? localOpportunityId(company, role),
      company,
      role,
    }
  })
}

function asVirtual(operation: UpsertOpportunityOperation): Opportunity {
  const submitted = operation.mode === 'submitted'
  return {
    id: operation.opportunityId,
    company: operation.company,
    role: operation.role,
    currentStageLabel: submitted ? '筛选中' : '待投',
    processStage: submitted ? 'screening' : 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 86,
    fitScore: 60,
    locallyManaged: true,
    importedAt: operation.occurredAt,
  }
}

function updateVirtual(virtual: Opportunity[], operation: ProgressOperation) {
  if (operation.kind === 'upsert_opportunity') {
    const existing = virtual.find((item) => item.id === operation.opportunityId)
    if (existing) {
      existing.company = operation.company
      existing.role = operation.role
      if (operation.mode === 'submitted') {
        existing.processStage = 'screening'
        existing.currentStageLabel = '筛选中'
      }
    } else virtual.push(asVirtual(operation))
  } else if (operation.kind === 'rename_opportunity') {
    const existing = virtual.find((item) => item.id === operation.opportunityId)
    if (existing) existing.role = operation.newRole
  } else if (operation.kind === 'close_opportunity') {
    const existing = virtual.find((item) => item.id === operation.opportunityId)
    if (existing) {
      existing.processStage = 'closed'
      existing.currentStageLabel = '流程结束'
    }
  }
}

function roleCore(role: string) {
  return compact(role.split(/[（(\-—]/)[0] ?? role)
}

function selectTarget(
  source: string,
  virtual: Opportunity[],
  touchedIds: string[],
  candidateIds?: string[],
  desiredStage?: ProcessStage,
) {
  let pool = candidateIds?.length
    ? virtual.filter((item) => candidateIds.includes(item.id))
    : virtual
  const mention = companyMention(source, pool)
  if (mention) pool = pool.filter((item) => sameCompany(item.company, mention.company))
  if (pool.length === 0) return undefined

  const sourceKey = compact(source)
  const roleMatches = pool.filter((item) => {
    const core = roleCore(item.role)
    return core.length >= 3 && sourceKey.includes(core)
  })
  if (roleMatches.length === 1) return roleMatches[0]

  for (let index = touchedIds.length - 1; index >= 0; index -= 1) {
    const touched = pool.find((item) => item.id === touchedIds[index])
    if (touched) return touched
  }

  if (desiredStage) {
    const stageMatches = pool.filter((item) => item.processStage === desiredStage)
    if (stageMatches.length === 1) return stageMatches[0]
  }
  const active = pool.filter((item) => item.processStage !== 'closed')
  if (active.length === 1) return active[0]
  if (pool.length === 1) return pool[0]
  return undefined
}

function stageForType(type: ProcessEventType): ProcessStage | undefined {
  if (type === 'assessment_invite') return 'assessment'
  if (type === 'written_test_invite') return 'written_test'
  if (type === 'interview_invite') return 'interview'
  if (type === 'offer') return 'offer'
  if (type === 'rejection') return 'closed'
  return undefined
}

function relativeDue(source: string, occurredAt: Date) {
  const hours = source.match(/(\d+(?:\.\d+)?)\s*小时(?:内)?/)
  if (hours?.[1]) return new Date(occurredAt.getTime() + Number(hours[1]) * HOUR).toISOString()
  const days = source.match(/(\d+(?:\.\d+)?)\s*(?:天|日)(?:内)?/)
  if (days?.[1]) return new Date(occurredAt.getTime() + Number(days[1]) * DAY).toISOString()
  return undefined
}

function clockTime(source: string) {
  const match = source.match(/(?:上午|早上|下午|晚上|晚间)?\s*(\d{1,2})(?:\s*[:：]\s*(\d{2})|\s*点\s*(?:(\d{1,2})\s*分?)?)/)
  if (!match?.[1]) return undefined
  let hour = Number(match[1])
  const minute = Number(match[2] ?? match[3] ?? 0)
  const segment = match[0]
  if (/(下午|晚上|晚间)/.test(segment) && hour < 12) hour += 12
  if (/(上午|早上)/.test(segment) && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return undefined
  return { hour, minute }
}

function localDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

function eventFromUnresolved(
  operation: UnresolvedOperation,
  target: Opportunity,
  now: Date,
): ProcessEventOperation | undefined {
  const detected = detectNotificationType(operation.sourceText)
  const type = detected.type
  if (!type || type === 'other' || type === 'status_update') return undefined
  const encodedDate = new Date(operation.occurredAt)
  const futureDate = localDay(encodedDate) > localDay(now)
  const pastDate = localDay(encodedDate) < localDay(now)
  const rel = relativeDue(operation.sourceText, encodedDate)
  const clock = clockTime(operation.sourceText)
  let dueAt = rel
  let timingMode: ActionTimingMode | undefined = rel ? 'deadline' : defaultTimingModeForProcessEvent(type)

  if (!dueAt && clock) {
    const due = new Date(encodedDate)
    due.setHours(clock.hour, clock.minute, 0, 0)
    dueAt = due.toISOString()
    if (type === 'interview_invite' || type === 'written_test_invite') timingMode = 'fixed'
  }
  if (!dueAt && type === 'assessment_invite') {
    const due = new Date(encodedDate)
    due.setHours(23, 59, 59, 0)
    dueAt = due.toISOString()
    timingMode = 'deadline'
  }

  const completed = pastDate && !/(收到|接到|通知|邀请|安排|将于|请于|请在|截止|小时|日内|天内)/.test(operation.sourceText)
  const actionable = ['assessment_invite', 'written_test_invite', 'interview_invite'].includes(type)
  if (actionable && !dueAt && !completed) return undefined

  return {
    id: operationId('event', operation.sourceText, `${target.id}|${type}|${dueAt ?? ''}`),
    kind: 'process_event',
    sourceText: operation.sourceText,
    confidence: 'medium',
    occurredAt: futureDate ? now.toISOString() : operation.occurredAt,
    opportunityId: target.id,
    company: target.company,
    role: target.role,
    eventType: type,
    dueAt,
    timingMode,
    estimatedMinutes: defaultMinutesForProcessEvent(type),
    completed,
  }
}

function repairExistingEvent(
  operation: ProcessEventOperation,
  virtual: Opportunity[],
  touchedIds: string[],
) {
  const target = selectTarget(
    operation.sourceText,
    virtual,
    touchedIds,
    undefined,
    stageForType(operation.eventType),
  )
  if (!target) return operation
  const mentioned = companyMention(operation.sourceText, virtual)
  const current = virtual.find((item) => item.id === operation.opportunityId)
  if (!mentioned || (current && sameCompany(current.company, mentioned.company))) return operation
  if (!sameCompany(target.company, mentioned.company)) return operation
  return {
    ...operation,
    opportunityId: target.id,
    company: target.company,
    role: target.role,
  }
}

function newCloseOperations(
  unresolvedOperation: UnresolvedOperation,
  virtual: Opportunity[],
): ProgressOperation[] | undefined {
  if (!/(流程(?:结束|终止)|终止流程|结束流程|流程关闭)/.test(unresolvedOperation.sourceText)) return undefined
  const payload = unresolvedOperation.sourceText
    .replace(/(?:流程(?:结束|终止)|终止流程|结束流程|流程关闭)/g, '')
    .trim()
  const anchor = earliestRoleAnchor(payload)
  if (!anchor) return undefined
  const company = normalizeNewCompany(payload.slice(0, anchor.index))
  const role = payload.slice(anchor.index).trim()
  if (company.length < 2 || role.length < 2) return undefined
  const existing = virtual.find((item) => sameCompany(item.company, company) && roleCore(item.role) === roleCore(role))
  const opportunityId = existing?.id ?? localOpportunityId(company, role)
  const result: ProgressOperation[] = []
  if (!existing) {
    result.push({
      id: operationId('archive-opportunity', unresolvedOperation.sourceText, opportunityId),
      kind: 'upsert_opportunity',
      sourceText: unresolvedOperation.sourceText,
      confidence: 'medium',
      occurredAt: unresolvedOperation.occurredAt,
      mode: 'submitted',
      opportunityId,
      company,
      role,
    })
  }
  result.push({
    id: operationId('close', unresolvedOperation.sourceText, opportunityId),
    kind: 'close_opportunity',
    sourceText: unresolvedOperation.sourceText,
    confidence: existing ? 'high' : 'medium',
    occurredAt: unresolvedOperation.occurredAt,
    opportunityId,
    company: existing?.company ?? company,
    role: existing?.role ?? role,
  })
  return result
}

function isHistoricalCompanyOnlyClosure(operation: UnresolvedOperation, now: Date) {
  return /(流程(?:结束|终止)|终止流程|结束流程|流程关闭)/.test(operation.sourceText) &&
    localDay(new Date(operation.occurredAt)) < localDay(now)
}

function standaloneTask(operation: UnresolvedOperation): ManualActionOperation | undefined {
  if (!/(校对|填写|提交|上传|确认|预约|完善)$/.test(operation.sourceText)) return undefined
  return {
    id: operationId('action', operation.sourceText),
    kind: 'manual_action',
    sourceText: operation.sourceText,
    confidence: 'medium',
    occurredAt: operation.occurredAt,
    title: operation.sourceText,
    dueAt: (() => {
      const date = new Date(operation.occurredAt)
      date.setHours(23, 59, 59, 0)
      return date.toISOString()
    })(),
    estimatedMinutes: 30,
  }
}

export function parseProgressUpdate(
  rawText: string,
  currentOpportunities: Opportunity[],
  now = new Date(),
): ProgressUpdatePlan {
  const base = parseV2(rawText, currentOpportunities, now)
  const virtual = currentOpportunities.map((item) => ({ ...item }))
  const repaired: ProgressOperation[] = []
  const touchedIds: string[] = []
  const repairedApplicationSources = new Set<string>()

  for (const operation of base.operations) {
    const application = applicationParts(operation.sourceText)
    if (application && !repairedApplicationSources.has(operation.sourceText)) {
      const parsed = inferApplication(operation.sourceText, virtual, operation.occurredAt)
      if (parsed?.length) {
        repairedApplicationSources.add(operation.sourceText)
        for (const item of parsed) {
          repaired.push(item)
          updateVirtual(virtual, item)
          if (parsed.length === 1) touchedIds.push(item.opportunityId)
        }
      }
    }

    if (
      application &&
      repairedApplicationSources.has(operation.sourceText) &&
      (operation.kind === 'upsert_opportunity' || operation.kind === 'unresolved')
    ) continue

    if (operation.kind === 'unresolved') {
      const task = standaloneTask(operation)
      if (task) {
        repaired.push(task)
        continue
      }

      const closeOps = newCloseOperations(operation, virtual)
      if (closeOps?.length) {
        for (const item of closeOps) {
          repaired.push(item)
          updateVirtual(virtual, item)
          if ('opportunityId' in item) touchedIds.push(item.opportunityId)
        }
        continue
      }

      const detected = detectNotificationType(operation.sourceText)
      if (detected.type && detected.type !== 'other' && detected.type !== 'status_update') {
        const candidates = operation.candidates?.map((item) => item.id)
        const target = selectTarget(
          operation.sourceText,
          virtual,
          touchedIds,
          candidates,
          stageForType(detected.type),
        )
        if (target) {
          const event = eventFromUnresolved(operation, target, now)
          if (event) {
            repaired.push(event)
            touchedIds.push(event.opportunityId)
            continue
          }
        }
      }

      if (isHistoricalCompanyOnlyClosure(operation, now)) {
        const ignored: IgnoredOperation = {
          id: operationId('ignored-close', operation.sourceText),
          kind: 'ignored',
          sourceText: operation.sourceText,
          confidence: 'high',
          occurredAt: operation.occurredAt,
          reason: '这是已结束的历史公司级流程，但缺少可靠岗位信息；它不影响当前 Today，无需强制补录。',
        }
        repaired.push(ignored)
        continue
      }

      repaired.push(operation)
      continue
    }

    if (operation.kind === 'process_event') {
      const next = repairExistingEvent(operation, virtual, touchedIds)
      repaired.push(next)
      touchedIds.push(next.opportunityId)
      continue
    }

    repaired.push(operation)
    updateVirtual(virtual, operation)
    if ('opportunityId' in operation && typeof operation.opportunityId === 'string') {
      touchedIds.push(operation.opportunityId)
    }
  }

  const unique = [...new Map(repaired.map((item) => [item.id, item])).values()]
  const unresolved = unique.filter((item): item is UnresolvedOperation => item.kind === 'unresolved')
  const ignored = unique.filter((item): item is IgnoredOperation => item.kind === 'ignored')
  const executable = unique.filter(
    (item): item is ExecutableProgressOperation => item.kind !== 'unresolved' && item.kind !== 'ignored',
  )
  return { operations: unique, executable, unresolved, ignored }
}
