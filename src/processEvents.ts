import type {
  Action,
  ActionTimingMode,
  Opportunity,
  ProcessEvent,
  ProcessEventType,
  ProcessRecord,
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

export function defaultTimingModeForProcessEvent(type: ProcessEventType): ActionTimingMode {
  return type === 'assessment_invite' ? 'deadline' : 'fixed'
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
  timingMode?: ActionTimingMode
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
    timingMode: input.timingMode ?? defaultTimingModeForProcessEvent(input.type),
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
    timingMode: event.timingMode ?? defaultTimingModeForProcessEvent(event.type),
    estimatedMinutes: event.estimatedMinutes ?? defaultMinutesForProcessEvent(event.type),
    leverage: leverage[event.type] ?? 88,
    delayCost: delayCost[event.type] ?? 90,
    status: 'todo',
    sourceLabel: '流程事件',
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  }
}

export function processEventStageLabel(event: ProcessEvent): string {
  const stage = stageForProcessEvent(event.type)
  const labels: Partial<Record<ProcessStage, string>> = {
    assessment: '测评',
    written_test: '笔试',
    interview: '面试',
    offer: 'Offer',
    closed: '流程结束',
  }
  return stage ? (labels[stage] ?? processEventLabels[event.type]) : processEventLabels[event.type]
}

function newerEvent(current: ProcessEvent | undefined, candidate: ProcessEvent) {
  if (!current) return candidate
  return candidate.occurredAt > current.occurredAt ? candidate : current
}

function latestEventMaps(events: ProcessEvent[]) {
  const latestAny = new Map<string, ProcessEvent>()
  const latestStage = new Map<string, ProcessEvent>()

  for (const event of events) {
    latestAny.set(event.opportunityId, newerEvent(latestAny.get(event.opportunityId), event))
    if (stageForProcessEvent(event.type)) {
      latestStage.set(event.opportunityId, newerEvent(latestStage.get(event.opportunityId), event))
    }
  }
  return { latestAny, latestStage }
}

function baselineProgressByOpportunity(processes: ProcessRecord[]) {
  const baseline = new Map<string, string>()
  for (const process of processes) {
    if (!process.opportunityId || !process.lastProgressAt) continue
    const current = baseline.get(process.opportunityId)
    if (!current || process.lastProgressAt > current) baseline.set(process.opportunityId, process.lastProgressAt)
  }
  return baseline
}

function projectedStageLabel(event: ProcessEvent, actionsById: Map<string, Action>) {
  const base = processEventStageLabel(event)
  const task = actionForProcessEvent(event)
  if (!task) return base
  const status = actionsById.get(task.id)?.status
  return status === 'done' ? `${base}完成 · 等待结果` : base
}

function projectedCurrentAction(event: ProcessEvent, actionsById: Map<string, Action>) {
  const task = actionForProcessEvent(event)
  if (!task) return undefined
  const status = actionsById.get(task.id)?.status
  if (status === 'done' || status === 'skipped') return undefined
  return task.title
}

export function overlayProcessEventsOnOpportunities(
  opportunities: Opportunity[],
  events: ProcessEvent[],
  processes: ProcessRecord[] = [],
): Opportunity[] {
  const { latestStage } = latestEventMaps(events)
  const baseline = baselineProgressByOpportunity(processes)

  return opportunities.map((opportunity): Opportunity => {
    const event = latestStage.get(opportunity.id)
    if (!event) return opportunity
    const importedProgress = baseline.get(opportunity.id)
    if (importedProgress && event.occurredAt <= importedProgress) return opportunity
    const stage = stageForProcessEvent(event.type)
    if (!stage) return opportunity
    return {
      ...opportunity,
      processStage: stage,
      currentStageLabel: processEventStageLabel(event),
      effectiveProcessEventId: event.id,
      effectiveProcessEventAt: event.occurredAt,
    }
  })
}

export function overlayProcessEventsOnProcesses(
  processes: ProcessRecord[],
  opportunities: Opportunity[],
  events: ProcessEvent[],
  actions: Action[] = [],
): ProcessRecord[] {
  const { latestAny, latestStage } = latestEventMaps(events)
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))
  const represented = new Set(processes.flatMap((item) => item.opportunityId ? [item.opportunityId] : []))
  const actionsById = new Map(actions.map((item) => [item.id, item]))

  const overlaid: ProcessRecord[] = processes.map((process): ProcessRecord => {
    if (!process.opportunityId) return process
    const latest = latestAny.get(process.opportunityId)
    if (!latest) return process
    if (process.lastProgressAt && latest.occurredAt <= process.lastProgressAt) return process

    const staged = latestStage.get(process.opportunityId)
    const stage = staged ? stageForProcessEvent(staged.type) : undefined

    return {
      ...process,
      stage: stage ?? process.stage,
      stageLabel: staged ? projectedStageLabel(staged, actionsById) : process.stageLabel,
      lastProgressAt: latest.occurredAt,
      nextCheckAt: staged ? undefined : process.nextCheckAt,
      silenceRisk: staged ? undefined : process.silenceRisk,
      currentAction: staged ? projectedCurrentAction(staged, actionsById) : process.currentAction,
      notes: latest.notes ?? process.notes,
      effectiveProcessEventId: staged?.id,
      effectiveProcessEventAt: staged?.occurredAt,
    }
  })

  for (const [opportunityId, latest] of latestAny) {
    if (represented.has(opportunityId)) continue
    const opportunity = opportunityMap.get(opportunityId)
    if (!opportunity) continue
    const staged = latestStage.get(opportunityId)
    const stage = staged ? stageForProcessEvent(staged.type) : undefined
    overlaid.push({
      id: `local-process:${opportunityId}`,
      opportunityId,
      company: opportunity.company,
      role: opportunity.role,
      stage: stage ?? opportunity.processStage,
      stageLabel: staged ? projectedStageLabel(staged, actionsById) : opportunity.currentStageLabel,
      lastProgressAt: latest.occurredAt,
      nextCheckAt: undefined,
      silenceRisk: undefined,
      currentAction: staged ? projectedCurrentAction(staged, actionsById) : undefined,
      notes: latest.notes,
      effectiveProcessEventId: staged?.id,
      effectiveProcessEventAt: staged?.occurredAt,
    })
  }

  return overlaid
}

export function reconcileProcessEventActions(
  actions: Action[],
  events: ProcessEvent[],
): Action[] {
  const byId = new Map(actions.map((item) => [item.id, item]))

  for (const event of events) {
    const generated = actionForProcessEvent(event)
    if (!generated) continue
    const previous = byId.get(generated.id)
    byId.set(generated.id, previous
      ? {
          ...generated,
          status: previous.status,
          createdAt: previous.createdAt,
          updatedAt: previous.updatedAt,
        }
      : generated)
  }

  return [...byId.values()]
}

export function suppressSupersededActions(
  actions: Action[],
  opportunities: Opportunity[],
): Action[] {
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))

  return actions.filter((action) => {
    if (!action.opportunityId) return true
    const opportunity = opportunityMap.get(action.opportunityId)

    if (action.processEventId) {
      if (opportunity?.effectiveProcessEventId) {
        return opportunity.effectiveProcessEventId === action.processEventId
      }
      return Boolean(
        opportunity &&
        action.dueAt &&
        action.processStage &&
        opportunity.processStage === action.processStage
      )
    }

    if (!opportunity?.effectiveProcessEventId) return true
    return action.kind !== 'apply' && action.kind !== 'follow_up'
  })
}
