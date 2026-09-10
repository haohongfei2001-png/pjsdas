import * as XLSX from 'xlsx'
import type {
  Action,
  ApplicationGroup,
  ImportBundle,
  Opportunity,
  OpportunityRole,
  Prep,
  ProcessRecord,
  ProcessStage,
} from './model'

const MAIN_SHEET = '投递总表'
const DETAIL_SHEET = '岗位详情'
const PIPELINE_SHEET = '在途流程'
const PREP_SHEET = '准备中心'
const GROUP_SHEET = '申请组'
const DAY = 86_400_000

function text(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function numberOrUndefined(value: unknown) {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function cleanOptional(value: unknown) {
  const result = text(value)
  return result && result !== '—' ? result : undefined
}

function getRecords(workbook: XLSX.WorkBook, sheetName: string, firstHeader: string) {
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) throw new Error(`缺少工作表：${sheetName}`)

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
  })
  const headerIndex = matrix.findIndex((row) => text(row?.[0]) === firstHeader)
  if (headerIndex < 0) throw new Error(`${sheetName} 中没有找到表头“${firstHeader}”`)

  const headers = matrix[headerIndex].map(text)
  return matrix.slice(headerIndex + 1).flatMap((row) => {
    if (!row || row.every((value) => value === null || text(value) === '')) return []
    const record: Record<string, unknown> = {}
    headers.forEach((header, index) => {
      if (header) record[header] = row[index]
    })
    return [record]
  })
}

function excelDate(value: unknown, dateOnlyMeansEndOfDay = false) {
  if (value === null || value === undefined || value === '') return undefined

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const date = new Date(value)
    if (
      dateOnlyMeansEndOfDay &&
      date.getHours() === 0 &&
      date.getMinutes() === 0 &&
      date.getSeconds() === 0
    ) {
      date.setHours(23, 59, 59, 0)
    }
    return date.toISOString()
  }

  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (!parsed) return undefined
    const hasExplicitTime = Math.abs(value - Math.floor(value)) > 1e-8
    const date = new Date(
      parsed.y,
      parsed.m - 1,
      parsed.d,
      hasExplicitTime ? parsed.H : dateOnlyMeansEndOfDay ? 23 : 0,
      hasExplicitTime ? parsed.M : dateOnlyMeansEndOfDay ? 59 : 0,
      hasExplicitTime ? Math.floor(parsed.S) : dateOnlyMeansEndOfDay ? 59 : 0,
    )
    return date.toISOString()
  }

  const raw = text(value)
  const dateOnly = raw.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
  if (dateOnly) {
    const date = new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      dateOnlyMeansEndOfDay ? 23 : 0,
      dateOnlyMeansEndOfDay ? 59 : 0,
      dateOnlyMeansEndOfDay ? 59 : 0,
    )
    return date.toISOString()
  }

  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function addDays(iso: string, days: number) {
  return new Date(new Date(iso).getTime() + days * DAY).toISOString()
}

export function parseMinutes(value: unknown, fallback = 30) {
  const raw = text(value).toLowerCase().replace(/\s+/g, '')
  if (!raw || raw === '—') return fallback

  const minuteRange = raw.match(/(\d+(?:\.\d+)?)[–—-](\d+(?:\.\d+)?)min/)
  if (minuteRange) return Math.round((Number(minuteRange[1]) + Number(minuteRange[2])) / 2)

  const minuteMax = raw.match(/[≤<](\d+(?:\.\d+)?)min/)
  if (minuteMax) return Math.round(Number(minuteMax[1]))

  const minutes = raw.match(/(\d+(?:\.\d+)?)min/)
  if (minutes) return Math.round(Number(minutes[1]))

  const hourRange = raw.match(/(\d+(?:\.\d+)?)[–—-](\d+(?:\.\d+)?)h/)
  if (hourRange) return Math.round(((Number(hourRange[1]) + Number(hourRange[2])) / 2) * 60)

  const hours = raw.match(/(\d+(?:\.\d+)?)h/)
  if (hours) return Math.round(Number(hours[1]) * 60)

  return fallback
}

function roleType(value: unknown): OpportunityRole {
  const raw = text(value)
  if (raw === '核心') return 'core'
  if (raw === '保底') return 'backup'
  if (raw === '冲刺') return 'reach'
  if (raw === '彩票') return 'lottery'
  return 'practice'
}

function opportunityValue(role: OpportunityRole) {
  const scores: Record<OpportunityRole, number> = {
    core: 94,
    backup: 76,
    reach: 90,
    lottery: 84,
    practice: 46,
  }
  return scores[role]
}

function fitScore(value: unknown) {
  const raw = text(value)
  if (raw === '高') return 90
  if (raw === '中高') return 76
  if (raw === '中') return 60
  if (raw === '中低') return 43
  if (raw === '低') return 22
  return 50
}

function processStage(value: unknown): ProcessStage {
  const raw = text(value)
  if (raw === '待投') return 'not_applied'
  if (raw.includes('待释放')) return 'waiting_release'
  if (raw.includes('Offer') || raw.includes('录用')) return 'offer'
  if (raw.includes('面试') || raw.includes('AI面') || raw.includes('试讲')) return 'interview'
  if (raw.includes('笔试')) return 'written_test'
  if (raw.includes('测评') || raw.includes('综合测评')) return 'assessment'
  if (raw.includes('筛选') || raw.includes('流程重启')) return 'screening'
  if (raw.includes('结束') || raw.includes('关闭')) return 'closed'
  return 'screening'
}

function prepPriority(priority: string) {
  if (priority === '最高') return { leverage: 96, delayCost: 78 }
  if (priority === '高') return { leverage: 88, delayCost: 64 }
  if (priority === '中高') return { leverage: 80, delayCost: 52 }
  if (priority === '中') return { leverage: 68, delayCost: 40 }
  return { leverage: 45, delayCost: 24 }
}

function findOpportunityId(opportunities: Opportunity[], company: string, role: string) {
  const companyKey = company.replace(/\s+/g, '').toLowerCase()
  const roleParts = role.split(/[\/；;]/).map((item) => item.trim()).filter(Boolean)
  const candidates = opportunities.filter((item) => {
    const key = item.company.replace(/\s+/g, '').toLowerCase()
    return key.includes(companyKey) || companyKey.includes(key)
  })
  if (candidates.length === 1) return candidates[0].id
  const exact = candidates.find((item) =>
    roleParts.some((part) => item.role.includes(part) || part.includes(item.role)),
  )
  return exact?.id
}

function minDate(values: Array<string | undefined>) {
  const dates = values.filter((value): value is string => Boolean(value))
  if (dates.length === 0) return undefined
  return dates.reduce((earliest, value) =>
    new Date(value).getTime() < new Date(earliest).getTime() ? value : earliest,
  )
}

function groupNeedsSingleAction(group: ApplicationGroup, candidates: Opportunity[]) {
  if (candidates.length <= 1) return false
  if (group.remaining !== undefined) return group.remaining < candidates.length
  // A group with several live candidates but an unknown remaining quota is
  // precisely the case where the user should verify the rule once instead of
  // receiving several independent "apply" instructions.
  return true
}

export async function parsePJSDASWorkbook(file: File): Promise<ImportBundle> {
  const importedAt = new Date().toISOString()
  const now = new Date()
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false })

  const main = getRecords(workbook, MAIN_SHEET, '岗位ID')
  const details = getRecords(workbook, DETAIL_SHEET, '岗位ID')
  const pipeline = getRecords(workbook, PIPELINE_SHEET, '公司')
  const prepRows = getRecords(workbook, PREP_SHEET, '能力包')
  const groupRows = getRecords(workbook, GROUP_SHEET, '申请组ID')

  const detailById = new Map(details.map((row) => [text(row['岗位ID']), row]))

  const opportunities: Opportunity[] = main.flatMap((row) => {
    const id = text(row['岗位ID'])
    if (!id) return []
    const detail = detailById.get(id)
    const role = roleType(row['机会角色'])

    return [{
      id,
      company: text(row['公司']),
      role: text(row['具体岗位']),
      currentStageLabel: text(row['当前阶段']) || '待投',
      processStage: processStage(row['当前阶段']),
      roleType: role,
      early: text(row['抢先']) === '是',
      deadline: excelDate(row['截止/保守节点'], true),
      sourcePriority: cleanOptional(row['P级']),
      offerProbability: cleanOptional(row['Offer成功率']),
      salaryReference: cleanOptional(row['年包参考']),
      nextActionLabel: cleanOptional(row['下一动作']),
      prepEstimateMinutes: cleanOptional(row['准备耗时']) ? parseMinutes(row['准备耗时']) : undefined,
      applicationGroupId: cleanOptional(row['申请组ID']),
      capacityStatus: cleanOptional(row['名额状态']),
      order: numberOrUndefined(row['序']),
      opportunityValue: opportunityValue(role),
      fitScore: fitScore(row['Offer成功率']),
      detail: detail ? {
        backgroundTag: cleanOptional(detail['背景标签']),
        coreOutput: cleanOptional(detail['核心产出']),
        workMode: cleanOptional(detail['工作方式']),
        candidateProfile: cleanOptional(detail['完整候选人画像']),
        jdSummary: cleanOptional(detail['硬资格 / JD摘要']),
        gap: cleanOptional(detail['与你的差距 / 待补']),
        salaryMinWan: numberOrUndefined(detail['年包下限(万)']),
        salaryMaxWan: numberOrUndefined(detail['年包上限(万)']),
        salaryConfidence: cleanOptional(detail['薪资可信度']),
        salaryBasis: cleanOptional(detail['薪资口径']),
        salaryRaw: cleanOptional(detail['原始薪资说明']),
        intensity: cleanOptional(detail['工作形态 / 强度']),
        windowType: cleanOptional(detail['窗口 / 截止类型']),
        earlyReason: cleanOptional(detail['抢先原因']),
        rules: cleanOptional(detail['关键规则 / 备注']),
      } : undefined,
      importedAt,
    }]
  })

  const applicationGroups: ApplicationGroup[] = groupRows.flatMap((row) => {
    const id = text(row['申请组ID'])
    if (!id) return []
    return [{
      id,
      company: text(row['公司/项目']),
      coveredRoles: cleanOptional(row['覆盖岗位']),
      rule: cleanOptional(row['名额规则']),
      total: numberOrUndefined(row['总名额']),
      used: numberOrUndefined(row['已用']),
      remaining: numberOrUndefined(row['剩余']),
      currentOrder: cleanOptional(row['当前排序/首选']),
      locked: text(row['是否锁定']) === '是',
      nextAction: cleanOptional(row['下一动作']),
      notes: cleanOptional(row['备注']),
    }]
  })

  const groupById = new Map(applicationGroups.map((group) => [group.id, group]))
  const actionablePending = opportunities.filter(
    (opportunity) =>
      opportunity.currentStageLabel === '待投' &&
      (!opportunity.deadline || new Date(opportunity.deadline).getTime() >= now.getTime()),
  )

  const pendingByGroup = new Map<string, Opportunity[]>()
  for (const opportunity of actionablePending) {
    if (!opportunity.applicationGroupId) continue
    const current = pendingByGroup.get(opportunity.applicationGroupId) ?? []
    current.push(opportunity)
    pendingByGroup.set(opportunity.applicationGroupId, current)
  }

  const groupedAsSingleAction = new Set<string>()
  for (const [groupId, candidates] of pendingByGroup) {
    const group = groupById.get(groupId)
    if (group && groupNeedsSingleAction(group, candidates)) groupedAsSingleAction.add(groupId)
  }

  const actions: Action[] = []

  for (const opportunity of actionablePending) {
    if (opportunity.applicationGroupId && groupedAsSingleAction.has(opportunity.applicationGroupId)) {
      continue
    }

    const estimatedMinutes = opportunity.prepEstimateMinutes ?? 45
    actions.push({
      id: `apply:${opportunity.id}`,
      kind: 'apply',
      title: `投递 ${opportunity.company}｜${opportunity.role}`,
      opportunityId: opportunity.id,
      applicationGroupId: opportunity.applicationGroupId,
      dueAt: opportunity.deadline,
      estimatedMinutes,
      leverage: opportunity.roleType === 'practice' ? 64 : 86,
      delayCost: opportunity.early ? 78 : opportunity.deadline ? 68 : 34,
      status: 'todo',
      sourceLabel: '投递总表',
      createdAt: importedAt,
      updatedAt: importedAt,
    })
  }

  for (const groupId of groupedAsSingleAction) {
    const group = groupById.get(groupId)
    const candidates = pendingByGroup.get(groupId) ?? []
    if (!group || candidates.length === 0) continue

    const dueAt = minDate(candidates.map((candidate) => candidate.deadline))
    const candidateMinutes = candidates.map((candidate) => candidate.prepEstimateMinutes ?? 45)
    const estimatedMinutes = Math.max(20, Math.min(...candidateMinutes))
    const hasKnownCapacityConflict = group.remaining !== undefined && group.remaining < candidates.length
    const instruction = group.nextAction ?? group.currentOrder ?? '核实共享志愿规则并择优提交'

    actions.push({
      id: `group:${group.id}`,
      kind: 'group_decision',
      title: `${group.company}｜${instruction}`,
      applicationGroupId: group.id,
      dueAt,
      estimatedMinutes,
      leverage: hasKnownCapacityConflict ? 94 : 88,
      delayCost: dueAt ? 78 : candidates.some((candidate) => candidate.early) ? 72 : 58,
      status: 'todo',
      sourceLabel: '申请组',
      createdAt: importedAt,
      updatedAt: importedAt,
    })
  }

  const processes: ProcessRecord[] = pipeline.flatMap((row, index) => {
    const company = text(row['公司'])
    const role = text(row['岗位'])
    if (!company) return []

    const stageLabel = text(row['当前阶段'])
    const lastProgressAt = excelDate(row['最后进展日'], true)
    const reviewThresholdDays = numberOrUndefined(row['复核阈值(天)'])
    const sourceNextCheckAt = excelDate(row['下次检查日'], true)
    const nextCheckAt =
      lastProgressAt && reviewThresholdDays !== undefined
        ? addDays(lastProgressAt, reviewThresholdDays)
        : sourceNextCheckAt
    const silenceRisk =
      nextCheckAt && new Date(nextCheckAt).getTime() <= now.getTime() ? '需复核' : '正常等待'
    const linkedOpportunityId = findOpportunityId(opportunities, company, role)

    if (nextCheckAt) {
      actions.push({
        id: `follow-up:${index + 1}`,
        kind: 'follow_up',
        title: `复核 ${company} 招聘流程`,
        opportunityId: linkedOpportunityId,
        dueAt: nextCheckAt,
        estimatedMinutes: 10,
        leverage: 62,
        delayCost: 55,
        status: 'todo',
        sourceLabel: '在途流程',
        createdAt: importedAt,
        updatedAt: importedAt,
      })
    }

    return [{
      id: `pipeline:${index + 1}`,
      opportunityId: linkedOpportunityId,
      company,
      role,
      stage: processStage(stageLabel),
      stageLabel,
      lastProgressAt,
      reviewThresholdDays,
      nextCheckAt,
      silenceRisk,
      currentAction: cleanOptional(row['当前动作']),
      prepPack: cleanOptional(row['触发准备包']),
      notes: cleanOptional(row['备注']),
    }]
  })

  const prep: Prep[] = prepRows.flatMap((row) => {
    const title = text(row['能力包'])
    if (!title) return []
    const sourceStatus = cleanOptional(row['状态'])
    const priorityLabel = cleanOptional(row['当前优先级'])
    const estimatedMinutes = parseMinutes(row['预计投入'], 90)
    const recentNodeAt = excelDate(row['最近节点'], true)
    const id = `prep:${title}`

    if (sourceStatus !== '等待触发') {
      const priority = prepPriority(priorityLabel ?? '')
      actions.push({
        id: `prep-action:${title}`,
        kind: 'prep',
        title: `准备｜${title}`,
        prepId: id,
        dueAt: recentNodeAt && new Date(recentNodeAt).getTime() > now.getTime() ? recentNodeAt : undefined,
        estimatedMinutes,
        leverage: priority.leverage,
        delayCost: priority.delayCost,
        status: 'todo',
        sourceLabel: '准备中心',
        createdAt: importedAt,
        updatedAt: importedAt,
      })
    }

    return [{
      id,
      title,
      triggeredBy: cleanOptional(row['触发岗位/申请组']),
      priorityLabel,
      recentNodeAt,
      minimumOutput: cleanOptional(row['本周最小产出']),
      estimatedMinutes,
      triggerRule: cleanOptional(row['触发/降级规则']),
      sourceStatus,
      createdAt: importedAt,
      updatedAt: importedAt,
    }]
  })

  return {
    opportunities,
    processes,
    actions,
    prep,
    applicationGroups,
    summary: {
      filename: file.name,
      importedAt,
      opportunities: opportunities.length,
      pending: opportunities.filter((item) => item.currentStageLabel === '待投').length,
      processes: processes.length,
      prep: prep.length,
      applicationGroups: applicationGroups.length,
      actions: actions.length,
    },
  }
}
