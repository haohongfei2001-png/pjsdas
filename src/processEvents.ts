import type {
  Action,
  Opportunity,
  ProcessEvent,
  ProcessEventType,
  ProcessStage,
} from './model'

export const processEventLabels: Record<ProcessEventType, string> = {
  assessment_invite: '测评通知',
  written_test_invite: '笔试通知',
  interview_invite: '面试通知',
  offer: 'Offer / 录用',
  rejection: '流程结束 / 拒绝',
  status_update: '流程状态更新',
  other: '其他进展',
}

export const actionableProcessEventTypes: ProcessEventType[] = [
  'assessment_invite',
  'written_test_invite',
  'interview_invite',
]

export function isActionableProcessEvent(type: ProcessEventType) {
  return actionableProcessEventTypes.includes(type)
}

export function stageForProcessEvent(type: ProcessEventType): ProcessStage | undefined {
  const stages: Partial<Record<ProcessEventType, ProcessStage>> = {
    assessment_invite: 'assessment',
    written_test_invite: 'written_test',
    interview_invite: 'interview',
    offer: 'offer',
    rejection: 'closed',
  }
  return stages[type]
}

export function defaultMinutesForProcessEvent(type: ProcessEventType) {
  const defaults: Record<ProcessEventType, number> = {
    assessment_invite: 45,
    written_test_invite: 90,
    interview_invite: 90,
    offer: 10,
    rejection: 5,
    status_update: 10,
    other: 10,
  }
  return defaults[type]
}

export interface NewProcessEventInput {
  opportunity: Opportunity
  type: ProcessEventType
  occurredAt: string
  dueAt?: string
  estimatedMinutes?: number
  notes?: string
  source?: ProcessEvent['source']
}

function nextId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function createProcessEvent(input: NewProcessEventInput): ProcessEvent {
  const now = new Date().toISOString()
  return {
    id: nextId(),
    opportunityId: input.opportunity.id,
    company: input.opportunity.company,
    role: input.opportunity.role,
    type: input.type,
    occurredAt: input.occurredAt,
    dueAt: input.dueAt || undefined,
    estimatedMinutes: input.estimatedMinutes ?? defaultMinutesForProcessEvent(input.type),
    notes: input.notes?.trim() || undefined,
    source: input.source ?? 'manual',
    createdAt: now,
    updatedAt: now,
  }
}

export function actionForProcessEvent(event: ProcessEvent): Action | undefined {
  if (!isActionableProcessEvent(event.type)) return undefined

  const stage = stageForProcessEvent(event.type)
  const titles: Partial<Record<ProcessEventType, string>> = {
    assessment_invite: `完成 ${event.company}｜测评`,
    written_test_invite: `完成 ${event.company}｜笔试`,
    interview_invite: `参加 ${event.company}｜面试`,
  }
  const leverage: Partial<Record<ProcessEventType, number>> = {
    assessment_invite: 90,
    written_test_invite: 94,
    interview_invite: 98,
  }
  const delayCost: Partial<Record<ProcessEventType, number>> = {
    assessment_invite: 92,
    written_test_invite: 95,
    interview_invite: 100,
  }

  return {
    id: `event-action:${event.id}`,
    kind: 'manual',
    title: titles[event.type] ?? `${event.company}｜流程任务`,
    opportunityId: event.opportunityId,
    processEventId: event.id,
    processStage: stage,
    dueAt: event.dueAt,
    estimatedMinutes: event.estimatedMinutes ?? defaultMinutesForProcessEvent(event.type),
    leverage: leverage[event.type] ?? 88,
    delayCost: delayCost[event.type] ?? 90,
    status: 'todo',
    sourceLabel: '流程事件',
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  }
}

export function processEventStageLabel(event: ProcessEvent) {
  const stage = stageForProcessEvent(event.type)
  const labels: Partial<Record<ProcessStage, string>> = {
    assessment: '测评',
    written_test: '笔试',
    interview: '面试',
    offer: 'Offer',
    closed: '流程结束',
  }
  return stage ? labels[stage] : processEventLabels[event.type]
}
