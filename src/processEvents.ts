import type {
  Action,
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
): ProcessRecord[] {
  const { latestAny, latestStage } = latestEventMaps(events)
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))
  const represented = new Set(processes.flatMap((item) => item.opportunityId ? [item.opportunityId] : []))

  const overlaid: ProcessRecord[] = processes.map((process): ProcessRecord => {
    if (!process.opportunityId) return process
    const latest = latestAny.get(process.opportunityId)
    if (!latest) return process
    if (process.lastProgressAt && latest.occurredAt <= process.lastProgressAt) return process

    const staged = latestStage.get(process.opportunityId)
    const stage = staged ? stageForProcessEvent(staged.type) : undefined
    const task = staged ? actionForProcessEvent(staged) : undefined

    return {
      ...process,
      stage: stage ?? process.stage,
      stageLabel: staged ? processEventStageLabel(staged) : process.stageLabel,
      lastProgressAt: latest.occurredAt,
      nextCheckAt: staged ? undefined : process.nextCheckAt,
      silenceRisk: staged ? undefined : process.silenceRisk,
      currentAction: task?.title ?? process.currentAction,
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
    const task = staged ? actionForProcessEvent(staged) : undefined
    overlaid.push({
      id: `local-process:${opportunityId}`,
      opportunityId,
      company: opportunity.company,
      role: opportunity.role,
      stage: stage ?? opportunity.processStage,
      stageLabel: staged ? processEventStageLabel(staged) : opportunity.currentStageLabel,
      lastProgressAt: latest.occurredAt,
      nextCheckAt: undefined,
      silenceRisk: undefined,
      currentAction: task?.title,
      notes: latest.notes,
      effectiveProcessEventId: staged?.id,
      effectiveProcessEventAt: staged?.occurredAt,
    })
  }

  return overlaid
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
      // Event Actions are only active while their event is the newest event that
      // actually projects over the imported baseline. This removes an old
      // assessment task after an interview/offer arrives and hides orphaned or
      // stale local events when a newer spreadsheet already moved the pipeline.
      return opportunity?.effectiveProcessEventId === action.processEventId
    }

    if (!opportunity?.effectiveProcessEventId) return true

    // A newer real recruiting event proves that an old application or silence
    // check for the same role has already been overtaken by reality. Keep the
    // imported record as baseline, but do not show its superseded Action.
    return action.kind !== 'apply' && action.kind !== 'follow_up'
  })
}
