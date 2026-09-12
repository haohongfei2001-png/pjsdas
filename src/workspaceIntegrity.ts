import { logicalJobMatches } from './jobPosting.js'
import { actionForProcessEvent } from './processEvents.js'
import type { PJSDASSnapshot } from './snapshot.js'

export type IntegritySeverity = 'critical' | 'warning' | 'info'

export interface WorkspaceIntegrityIssue {
  code:
    | 'duplicate_opportunity'
    | 'duplicate_posting_source'
    | 'orphan_process_event'
    | 'orphan_action_opportunity'
    | 'orphan_action_process_event'
    | 'missing_process_action'
    | 'closed_opportunity_active_action'
    | 'expired_not_applied_opportunity'
    | 'duplicate_entity_id'
  severity: IntegritySeverity
  title: string
  detail: string
  opportunityIds?: string[]
  processEventIds?: string[]
  actionIds?: string[]
  sourceRef?: string
}

export interface WorkspaceIntegritySummary {
  status: 'healthy' | 'watch' | 'critical'
  score: number
  issueCount: number
  criticalCount: number
  warningCount: number
  infoCount: number
  issues: WorkspaceIntegrityIssue[]
  scanned: {
    opportunities: number
    processEvents: number
    actions: number
  }
  generatedAt: string
}

function duplicateIds<T extends { id: string }>(items: T[]) {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1)
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id)
}

function canonicalPostingUrl(opportunity: PJSDASSnapshot['data']['opportunities'][number]) {
  return opportunity.detail?.discovery?.posting?.canonicalSourceUrl?.trim()
}

function expired(deadline: string | undefined, now: Date) {
  if (!deadline) return false
  const value = /^\d{4}-\d{2}-\d{2}$/.test(deadline)
    ? new Date(`${deadline}T23:59:59.999Z`).getTime()
    : new Date(deadline).getTime()
  return Number.isFinite(value) && value < now.getTime()
}

function activeStatus(status: string) {
  return status === 'todo' || status === 'in_progress'
}

function scoreFor(issues: WorkspaceIntegrityIssue[]) {
  const penalty = issues.reduce((sum, issue) => {
    if (issue.severity === 'critical') return sum + 25
    if (issue.severity === 'warning') return sum + 6
    return sum + 1
  }, 0)
  return Math.max(0, 100 - penalty)
}

export function auditWorkspaceIntegrity(snapshot: PJSDASSnapshot, now = new Date()): WorkspaceIntegritySummary {
  const { opportunities, processEvents, actions } = snapshot.data
  const issues: WorkspaceIntegrityIssue[] = []
  const opportunityById = new Map(opportunities.map((item) => [item.id, item]))
  const eventById = new Map(processEvents.map((item) => [item.id, item]))
  const actionById = new Map(actions.map((item) => [item.id, item]))

  for (const [entity, ids] of [
    ['Opportunity', duplicateIds(opportunities)],
    ['ProcessEvent', duplicateIds(processEvents)],
    ['Action', duplicateIds(actions)],
  ] as const) {
    for (const id of ids) {
      issues.push({
        code: 'duplicate_entity_id',
        severity: 'critical',
        title: `${entity} 存在重复 ID`,
        detail: `${entity} id=${id} 出现多次；任何自动写入都应在修复前 fail-closed。`,
        opportunityIds: entity === 'Opportunity' ? [id] : undefined,
        processEventIds: entity === 'ProcessEvent' ? [id] : undefined,
        actionIds: entity === 'Action' ? [id] : undefined,
      })
    }
  }

  for (let left = 0; left < opportunities.length; left += 1) {
    for (let right = left + 1; right < opportunities.length; right += 1) {
      const a = opportunities[left]!
      const b = opportunities[right]!
      if (logicalJobMatches(
        { company: a.company, role: a.role, location: a.detail?.discovery?.location },
        { company: b.company, role: b.role, location: b.detail?.discovery?.location },
      )) {
        issues.push({
          code: 'duplicate_opportunity',
          severity: 'warning',
          title: `疑似重复岗位｜${a.company}`,
          detail: `“${a.role}” 与 “${b.role}” 被岗位身份规则判为同一或高度相似逻辑岗位；只报告，不自动合并。`,
          opportunityIds: [a.id, b.id],
        })
      }
    }
  }

  const postingOwners = new Map<string, string[]>()
  for (const opportunity of opportunities) {
    const url = canonicalPostingUrl(opportunity)
    if (!url) continue
    const owners = postingOwners.get(url) ?? []
    owners.push(opportunity.id)
    postingOwners.set(url, owners)
  }
  for (const [url, owners] of postingOwners) {
    if (owners.length <= 1) continue
    issues.push({
      code: 'duplicate_posting_source',
      severity: 'warning',
      title: '同一 canonical posting 归属于多个 Opportunity',
      detail: `${url} 当前关联 ${owners.length} 个 Opportunity；可能是重复岗位，也可能是来源建模错误。`,
      opportunityIds: owners,
      sourceRef: url,
    })
  }

  for (const event of processEvents) {
    if (!opportunityById.has(event.opportunityId)) {
      issues.push({
        code: 'orphan_process_event', severity: 'critical', title: '流程事件缺少所属 Opportunity',
        detail: `${event.company}｜${event.role} 的 ProcessEvent ${event.id} 指向不存在的 opportunityId=${event.opportunityId}。`,
        processEventIds: [event.id], opportunityIds: [event.opportunityId],
      })
      continue
    }
    const generated = actionForProcessEvent(event)
    if (generated && !actionById.has(generated.id)) {
      issues.push({
        code: 'missing_process_action', severity: 'warning', title: '可执行流程事件缺少持久化 Action',
        detail: `${event.company}｜${event.role} 的 ${event.type} 应有 ${generated.id}；读层可重建，但持久化状态不完整。`,
        opportunityIds: [event.opportunityId], processEventIds: [event.id], actionIds: [generated.id],
      })
    }
  }

  for (const action of actions) {
    if (action.opportunityId && !opportunityById.has(action.opportunityId)) {
      issues.push({
        code: 'orphan_action_opportunity', severity: 'critical', title: 'Action 指向不存在的 Opportunity',
        detail: `${action.title} (${action.id}) 指向不存在的 opportunityId=${action.opportunityId}。`,
        actionIds: [action.id], opportunityIds: [action.opportunityId],
      })
    }
    if (action.processEventId && !eventById.has(action.processEventId)) {
      issues.push({
        code: 'orphan_action_process_event', severity: 'critical', title: 'Action 指向不存在的 ProcessEvent',
        detail: `${action.title} (${action.id}) 指向不存在的 processEventId=${action.processEventId}。`,
        actionIds: [action.id], processEventIds: [action.processEventId],
      })
    }
    if (action.opportunityId && activeStatus(action.status)) {
      const opportunity = opportunityById.get(action.opportunityId)
      if (opportunity?.processStage === 'closed') {
        issues.push({
          code: 'closed_opportunity_active_action', severity: 'warning', title: '已结束流程仍有活动待办',
          detail: `${opportunity.company}｜${opportunity.role} 已处于 closed，但 ${action.id} 仍为 ${action.status}。`,
          opportunityIds: [opportunity.id], actionIds: [action.id],
        })
      }
    }
  }

  for (const opportunity of opportunities) {
    if (opportunity.processStage === 'not_applied' && expired(opportunity.deadline, now)) {
      issues.push({
        code: 'expired_not_applied_opportunity', severity: 'info', title: '待投岗位截止时间已过去',
        detail: `${opportunity.company}｜${opportunity.role} 仍为 not_applied，但 deadline=${opportunity.deadline} 已过去；需要后续事实更新，不自动关闭。`,
        opportunityIds: [opportunity.id],
      })
    }
  }

  const criticalCount = issues.filter((item) => item.severity === 'critical').length
  const warningCount = issues.filter((item) => item.severity === 'warning').length
  const infoCount = issues.filter((item) => item.severity === 'info').length
  const score = scoreFor(issues)
  return {
    status: criticalCount > 0 ? 'critical' : warningCount > 0 ? 'watch' : 'healthy',
    score,
    issueCount: issues.length,
    criticalCount,
    warningCount,
    infoCount,
    issues,
    scanned: { opportunities: opportunities.length, processEvents: processEvents.length, actions: actions.length },
    generatedAt: now.toISOString(),
  }
}
