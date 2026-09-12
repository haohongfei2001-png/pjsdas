import { validateDecisionRules, type DecisionRules } from './decisionRules.js'
import { progressOperationSummary, type ExecutableProgressOperation } from './progressUpdate.js'
import { validateOpportunityFacts } from './richOpportunity.js'
import type { Action, ActionStatus, Opportunity, OpportunityFacts, ProcessEvent } from './model.js'

export type ChangeSetStatus = 'pending' | 'applied' | 'discarded' | 'failed'
export type ChangeSetSource = 'natural_language' | 'rules' | 'process_event' | 'user_action' | 'api' | 'mcp'

type StripProgressMetadata<T> = T extends unknown ? Omit<T, 'sourceText' | 'confidence'> : never
export type StoredProgressOperation = StripProgressMetadata<ExecutableProgressOperation>

export type ChangeSetOperation =
  | {
      id: string
      kind: 'progress_update'
      summary: string
      operation: StoredProgressOperation
    }
  | {
      id: string
      kind: 'replace_decision_rules'
      summary: string
      expectedUpdatedAt: string
      mode: 'save' | 'reset'
      rules: DecisionRules
    }
  | {
      id: string
      kind: 'add_process_event'
      summary: string
      event: ProcessEvent
    }
  | {
      id: string
      kind: 'delete_process_event'
      summary: string
      eventId: string
    }
  | {
      id: string
      kind: 'set_action_status'
      summary: string
      actionId: string
      expectedStatus: ActionStatus
      status: ActionStatus
    }
  | {
      id: string
      kind: 'add_discovered_opportunity'
      summary: string
      opportunity: Opportunity
    }

export interface ChangeSetRecord {
  id: string
  version: 1
  source: ChangeSetSource
  status: ChangeSetStatus
  title: string
  createdAt: string
  updatedAt: string
  expectedWorkspaceVersion?: string
  expectedWorkspaceFingerprint?: string
  appliedAt?: string
  discardedAt?: string
  failedAt?: string
  error?: string
  operations: ChangeSetOperation[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validIso(value: unknown) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
}

function validPublicHttpUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2_000) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    const host = url.hostname.toLocaleLowerCase()
    if (!host || host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.startsWith('127.')) return false
    return true
  } catch {
    return false
  }
}

function changeSetId(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0')
  return `CS-${stamp}-${suffix}`
}

function baseChangeSet(source: ChangeSetSource, title: string, operations: ChangeSetOperation[], now = new Date()): ChangeSetRecord {
  const timestamp = now.toISOString()
  return {
    id: changeSetId(now),
    version: 1,
    source,
    status: 'pending',
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    operations,
  }
}

function stripProgressOperation(operation: ExecutableProgressOperation): StoredProgressOperation {
  const { sourceText: _sourceText, confidence: _confidence, ...stored } = operation
  return stored as StoredProgressOperation
}

export function createProgressChangeSet(operations: ExecutableProgressOperation[], now = new Date()) {
  const items: ChangeSetOperation[] = operations.map((operation) => ({
    id: `progress:${operation.id}`,
    kind: 'progress_update',
    summary: progressOperationSummary(operation),
    operation: stripProgressOperation(operation),
  }))
  return baseChangeSet('natural_language', `自然语言更新 · ${items.length} 项`, items, now)
}

export function restoreProgressOperation(operation: Extract<ChangeSetOperation, { kind: 'progress_update' }>, changeSetIdValue: string): ExecutableProgressOperation {
  return {
    ...operation.operation,
    sourceText: `ChangeSet ${changeSetIdValue} · ${operation.summary}`,
    confidence: 'high',
  } as ExecutableProgressOperation
}

function comparableRules(rules: DecisionRules) {
  return {
    ...rules,
    updatedAt: '',
    weights: { ...rules.weights },
  }
}

export function decisionRulesEquivalent(a: DecisionRules, b: DecisionRules) {
  return JSON.stringify(comparableRules(a)) === JSON.stringify(comparableRules(b))
}

export function createRulesChangeSet(before: DecisionRules, after: DecisionRules, mode: 'save' | 'reset', now = new Date()) {
  if (decisionRulesEquivalent(before, after)) return undefined
  const timestamp = now.toISOString()
  const proposed: DecisionRules = {
    ...after,
    key: 'current',
    version: 1,
    weights: { ...after.weights },
    updatedAt: timestamp,
  }
  return baseChangeSet('rules', mode === 'reset' ? '恢复推荐决策规则' : '修改决策规则', [{
    id: 'rules:current',
    kind: 'replace_decision_rules',
    summary: mode === 'reset' ? '恢复 PJSDAS 推荐规则' : '应用当前规则修改',
    expectedUpdatedAt: before.updatedAt,
    mode,
    rules: proposed,
  }], now)
}

function processEventName(type: ProcessEvent['type']) {
  if (type === 'assessment_invite') return '测评'
  if (type === 'written_test_invite') return '笔试'
  if (type === 'interview_invite') return '面试'
  if (type === 'offer') return 'Offer'
  if (type === 'rejection') return '流程结束'
  if (type === 'status_update') return '流程更新'
  return '流程事件'
}

export function createProcessEventChangeSet(event: ProcessEvent, now = new Date()) {
  const label = `${event.company}｜${event.role} · ${processEventName(event.type)}`
  return baseChangeSet('process_event', '记录流程通知', [{
    id: `process:add:${event.id}`,
    kind: 'add_process_event',
    summary: `记录 ${label}`,
    event,
  }], now)
}

export function createProcessEventDeleteChangeSet(event: ProcessEvent, now = new Date()) {
  return baseChangeSet('user_action', '删除错误流程事件', [{
    id: `process:delete:${event.id}`,
    kind: 'delete_process_event',
    summary: `删除 ${event.company}｜${event.role} 的 ${processEventName(event.type)}`,
    eventId: event.id,
  }], now)
}

export function createActionStatusChangeSet(action: Action, status: ActionStatus, now = new Date()) {
  if (action.status === status) return undefined
  const verb = status === 'done' ? '完成' : status === 'skipped' ? '跳过' : status === 'doing' ? '开始' : '恢复'
  return baseChangeSet('user_action', `${verb}行动`, [{
    id: `action:${action.id}:${status}`,
    kind: 'set_action_status',
    summary: `${verb}｜${action.title}`,
    actionId: action.id,
    expectedStatus: action.status,
    status,
  }], now)
}

function validateDiscoveredOpportunity(raw: Record<string, unknown>, operationId: string, errors: string[]) {
  const opportunity = raw.opportunity
  if (!isObject(opportunity)) {
    errors.push(`ChangeSet operation ${operationId} 缺少岗位发现 payload。`)
    return
  }
  if (typeof opportunity.id !== 'string' || !opportunity.id.trim()) errors.push(`ChangeSet operation ${operationId} 的岗位 ID 无效。`)
  if (typeof opportunity.company !== 'string' || !opportunity.company.trim() || opportunity.company.length > 200) errors.push(`ChangeSet operation ${operationId} 的公司名无效。`)
  if (typeof opportunity.role !== 'string' || !opportunity.role.trim() || opportunity.role.length > 240) errors.push(`ChangeSet operation ${operationId} 的岗位名无效。`)
  if (opportunity.processStage !== 'not_applied' || opportunity.currentStageLabel !== '待投') errors.push(`ChangeSet operation ${operationId} 的发现岗位必须处于待投状态。`)
  if (!['core', 'backup', 'reach', 'lottery', 'practice'].includes(String(opportunity.roleType))) errors.push(`ChangeSet operation ${operationId} 的岗位类型无效。`)
  if (typeof opportunity.opportunityValue !== 'number' || opportunity.opportunityValue < 0 || opportunity.opportunityValue > 100) errors.push(`ChangeSet operation ${operationId} 的机会价值无效。`)
  if (typeof opportunity.fitScore !== 'number' || opportunity.fitScore < 0 || opportunity.fitScore > 100) errors.push(`ChangeSet operation ${operationId} 的匹配度无效。`)
  if (opportunity.locallyManaged !== true) errors.push(`ChangeSet operation ${operationId} 的发现岗位必须标记为本地管理。`)
  if (!validIso(opportunity.importedAt)) errors.push(`ChangeSet operation ${operationId} 的发现时间无效。`)
  if (opportunity.deadline !== undefined && !validIso(opportunity.deadline)) errors.push(`ChangeSet operation ${operationId} 的截止时间无效。`)

  if (!isObject(opportunity.detail) || !isObject(opportunity.detail.discovery)) {
    errors.push(`ChangeSet operation ${operationId} 缺少来源证据。`)
    return
  }
  if (opportunity.detail.facts !== undefined) {
    if (!isObject(opportunity.detail.facts)) errors.push(`ChangeSet operation ${operationId} 的 Rich Opportunity facts 无效。`)
    else {
      const factErrors = validateOpportunityFacts(opportunity.detail.facts as unknown as OpportunityFacts)
      if (factErrors.length) errors.push(`ChangeSet operation ${operationId} 的 Rich Opportunity facts 无效：${factErrors[0]}`)
    }
  }
  const discovery = opportunity.detail.discovery
  if (!validPublicHttpUrl(discovery.sourceUrl)) errors.push(`ChangeSet operation ${operationId} 的来源 URL 无效。`)
  if (typeof discovery.sourceTitle !== 'string' || !discovery.sourceTitle.trim() || discovery.sourceTitle.length > 300) errors.push(`ChangeSet operation ${operationId} 的来源标题无效。`)
  if (typeof discovery.rationale !== 'string' || !discovery.rationale.trim() || discovery.rationale.length > 1600) errors.push(`ChangeSet operation ${operationId} 的匹配理由无效。`)
  if (!validIso(discovery.discoveredAt)) errors.push(`ChangeSet operation ${operationId} 的发现时间证据无效。`)
  if (!['high', 'medium', 'low'].includes(String(discovery.fitConfidence))) errors.push(`ChangeSet operation ${operationId} 的匹配度置信度无效。`)
  if (!['high', 'medium', 'low'].includes(String(discovery.opportunityValueConfidence))) errors.push(`ChangeSet operation ${operationId} 的机会价值置信度无效。`)
  if (discovery.location !== undefined && (typeof discovery.location !== 'string' || discovery.location.length > 240)) errors.push(`ChangeSet operation ${operationId} 的地点字段无效。`)
  if (discovery.compensationText !== undefined && (typeof discovery.compensationText !== 'string' || discovery.compensationText.length > 500)) errors.push(`ChangeSet operation ${operationId} 的薪资证据无效。`)
  if (discovery.profileWarnings !== undefined && (!Array.isArray(discovery.profileWarnings) || discovery.profileWarnings.length > 10 || discovery.profileWarnings.some((item) => typeof item !== 'string' || item.length > 300))) {
    errors.push(`ChangeSet operation ${operationId} 的岗位发现警告无效。`)
  }
}

export function validateChangeSet(value: unknown): string[] {
  const errors: string[] = []
  if (!isObject(value)) return ['ChangeSet 必须是对象。']
  if (typeof value.id !== 'string' || !value.id.trim()) errors.push('ChangeSet 缺少 ID。')
  if (value.version !== 1) errors.push('ChangeSet 版本必须为 1。')
  if (!['natural_language', 'rules', 'process_event', 'user_action', 'api', 'mcp'].includes(String(value.source))) errors.push('ChangeSet source 无效。')
  if (!['pending', 'applied', 'discarded', 'failed'].includes(String(value.status))) errors.push('ChangeSet status 无效。')
  if (typeof value.title !== 'string' || !value.title.trim()) errors.push('ChangeSet 缺少标题。')
  if (!validIso(value.createdAt) || !validIso(value.updatedAt)) errors.push('ChangeSet 时间字段无效。')
  if (value.expectedWorkspaceVersion !== undefined && (typeof value.expectedWorkspaceVersion !== 'string' || !value.expectedWorkspaceVersion.trim())) {
    errors.push('ChangeSet 工作区基线版本无效。')
  }
  if (value.expectedWorkspaceFingerprint !== undefined &&
    (typeof value.expectedWorkspaceFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(value.expectedWorkspaceFingerprint))) {
    errors.push('ChangeSet 工作区基线指纹无效。')
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    errors.push('ChangeSet 至少需要一个 operation。')
    return errors
  }

  const discoveryOperationCount = value.operations.filter((item) => isObject(item) && item.kind === 'add_discovered_opportunity').length
  if (discoveryOperationCount > 0 && discoveryOperationCount !== value.operations.length) {
    errors.push('岗位发现 ChangeSet 不能与其他修改类型混合，请拆分审阅。')
  }

  for (const raw of value.operations) {
    if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.summary !== 'string') {
      errors.push('ChangeSet operation 基础字段无效。')
      continue
    }
    if (raw.kind === 'progress_update') {
      if (!isObject(raw.operation) || typeof raw.operation.kind !== 'string' || !validIso(raw.operation.occurredAt)) {
        errors.push(`ChangeSet operation ${raw.id} 的 progress payload 无效。`)
      }
      if ('sourceText' in (raw.operation as Record<string, unknown>)) errors.push(`ChangeSet operation ${raw.id} 不应持久化原始输入。`)
    } else if (raw.kind === 'replace_decision_rules') {
      if (!isObject(raw.rules)) errors.push(`ChangeSet operation ${raw.id} 缺少规则。`)
      else {
        const ruleErrors = validateDecisionRules(raw.rules as unknown as DecisionRules)
        if (ruleErrors.length) errors.push(`ChangeSet operation ${raw.id} 的规则无效：${ruleErrors[0]}`)
      }
      if (typeof raw.expectedUpdatedAt !== 'string') errors.push(`ChangeSet operation ${raw.id} 缺少规则基线版本。`)
    } else if (raw.kind === 'add_process_event') {
      if (!isObject(raw.event) || typeof raw.event.id !== 'string' || !validIso(raw.event.occurredAt)) errors.push(`ChangeSet operation ${raw.id} 的流程事件无效。`)
    } else if (raw.kind === 'delete_process_event') {
      if (typeof raw.eventId !== 'string' || !raw.eventId) errors.push(`ChangeSet operation ${raw.id} 缺少 eventId。`)
    } else if (raw.kind === 'set_action_status') {
      if (typeof raw.actionId !== 'string' || !raw.actionId) errors.push(`ChangeSet operation ${raw.id} 缺少 actionId。`)
      if (!['todo', 'doing', 'done', 'skipped'].includes(String(raw.expectedStatus)) || !['todo', 'doing', 'done', 'skipped'].includes(String(raw.status))) errors.push(`ChangeSet operation ${raw.id} 的 Action 状态无效。`)
    } else if (raw.kind === 'add_discovered_opportunity') {
      validateDiscoveredOpportunity(raw, raw.id, errors)
    } else {
      errors.push(`ChangeSet operation ${raw.id} kind 无效。`)
    }
  }
  return errors
}

export function assertChangeSetValid(value: unknown): asserts value is ChangeSetRecord {
  const errors = validateChangeSet(value)
  if (errors.length) throw new Error(errors[0])
}