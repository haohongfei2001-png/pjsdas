import { decisionRulesForSnapshot } from './decisionRules.js'
import { discoveryProfileForSnapshot } from './discoveryProfile.js'
import { evaluateDiscoveryCandidate, findSimilarOpportunity } from './discoveryQuality.js'
import {
  createJobPostingEvidence,
  jobIdentityKey,
  mergeJobPostingEvidence,
} from './jobPosting.js'
import {
  alreadyIngested,
  buildIngestionRunSummary,
  createIngestionLedgerTimeline,
  createIngestionRunTimeline,
  stableIngestionHash,
} from './ingestion.js'
import {
  actionForProcessEvent,
  processEventStageLabel,
  stageForProcessEvent,
} from './processEvents.js'
import { validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import { timelineFromProcessEvent } from './timeline.js'
import type {
  Action,
  ActionTimingMode,
  DiscoveryConfidence,
  IngestionRunSummary,
  JobPostingStatus,
  Opportunity,
  OpportunityRole,
  ProcessEvent,
  ProcessEventType,
  ProcessStage,
  TimelineRecord,
} from './model.js'

export interface MonitorJobObservation {
  sourceRecordId: string
  company: string
  role: string
  sourceUrl: string
  sourceTitle: string
  location?: string
  deadline?: string
  compensationText?: string
  rationale: string
  roleType: OpportunityRole
  opportunityValue: number
  fitScore: number
  fitConfidence: DiscoveryConfidence
  opportunityValueConfidence: DiscoveryConfidence
  postingStatus?: JobPostingStatus
  discoveredAt?: string
}

export interface MonitorIngestionRunInput {
  runId: string
  sourceId: string
  startedAt: string
  completedAt: string
  observations: MonitorJobObservation[]
}

export interface GmailMessageObservation {
  sourceRecordId: string
  receivedAt: string
  classification: 'recruiting' | 'ignored'
  confidence: DiscoveryConfidence
  sender?: string
  subject?: string
  company?: string
  role?: string
  eventType?: ProcessEventType
  dueAt?: string
  timingMode?: ActionTimingMode
  estimatedMinutes?: number
  notes?: string
  stage?: ProcessStage
  stageLabel?: string
  roleType?: OpportunityRole
  fitScore?: number
  opportunityValue?: number
}

export interface GmailIngestionRunInput {
  runId: string
  sourceId: string
  startedAt: string
  completedAt: string
  cursor?: string
  messages: GmailMessageObservation[]
}

export interface AutonomousIngestionResult {
  snapshot: PJSDASSnapshot
  run: IngestionRunSummary
  records: TimelineRecord[]
  alreadyApplied: boolean
  createdOpportunityIds: string[]
  touchedOpportunityIds: string[]
  processEventIds: string[]
}

function validIso(value: string) {
  return !Number.isNaN(new Date(value).getTime())
}

function runAlreadyApplied(snapshot: PJSDASSnapshot, sourceKind: 'gpt_monitor' | 'gmail', sourceId: string, runId: string) {
  return (snapshot.data.timeline ?? []).find((item) =>
    item.ingestionRun?.sourceKind === sourceKind &&
    item.ingestionRun.sourceId === sourceId &&
    item.ingestionRun.runId === runId,
  )?.ingestionRun
}

function withTimeline(records: TimelineRecord[], incoming: TimelineRecord[]) {
  const byId = new Map(records.map((item) => [item.id, item]))
  for (const record of incoming) byId.set(record.id, record)
  return [...byId.values()]
}

function applyActionForNewOpportunity(opportunity: Opportunity, observedAt: string): Action {
  return {
    id: `apply:${opportunity.id}`,
    kind: 'apply',
    title: `投递 ${opportunity.company}｜${opportunity.role}`,
    opportunityId: opportunity.id,
    processStage: 'not_applied',
    dueAt: opportunity.deadline,
    timingMode: opportunity.deadline ? 'deadline' : undefined,
    estimatedMinutes: opportunity.prepEstimateMinutes ?? 45,
    leverage: 70,
    delayCost: opportunity.deadline ? 65 : 40,
    status: 'todo',
    sourceLabel: '自动岗位监控',
    createdAt: observedAt,
    updatedAt: observedAt,
  }
}

function monitorOpportunityId(observation: MonitorJobObservation) {
  const identity = jobIdentityKey(observation.company, observation.role, observation.location)
  return `auto-opportunity:${stableIngestionHash(identity || `${observation.company}|${observation.role}`)}`
}

function createMonitorOpportunity(observation: MonitorJobObservation, observedAt: string): Opportunity {
  const posting = createJobPostingEvidence({
    company: observation.company,
    role: observation.role,
    sourceUrl: observation.sourceUrl,
    sourceTitle: observation.sourceTitle,
    location: observation.location,
    deadline: observation.deadline,
    compensationText: observation.compensationText,
    postingStatus: observation.postingStatus ?? 'unknown',
    observedAt,
  })
  return {
    id: monitorOpportunityId(observation),
    company: observation.company.trim(),
    role: observation.role.trim(),
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: observation.roleType,
    early: false,
    deadline: observation.deadline,
    sourcePriority: 'GPT Monitor 自动摄入',
    salaryReference: observation.compensationText,
    nextActionLabel: '审阅并投递',
    prepEstimateMinutes: 45,
    opportunityValue: observation.opportunityValue,
    fitScore: observation.fitScore,
    locallyManaged: true,
    importedAt: observedAt,
    detail: {
      discovery: {
        sourceUrl: observation.sourceUrl,
        sourceTitle: observation.sourceTitle,
        location: observation.location,
        compensationText: observation.compensationText,
        rationale: observation.rationale,
        discoveredAt: observedAt,
        fitConfidence: observation.fitConfidence,
        opportunityValueConfidence: observation.opportunityValueConfidence,
        posting,
      },
    },
  }
}

function mergeMonitorObservation(existing: Opportunity, observation: MonitorJobObservation, observedAt: string) {
  const incoming = createJobPostingEvidence({
    company: observation.company,
    role: observation.role,
    sourceUrl: observation.sourceUrl,
    sourceTitle: observation.sourceTitle,
    location: observation.location,
    deadline: observation.deadline,
    compensationText: observation.compensationText,
    postingStatus: observation.postingStatus ?? 'unknown',
    observedAt,
  })
  const discovery = existing.detail?.discovery
  const current = discovery?.posting
  const mergedPosting = current
    ? mergeJobPostingEvidence(current, discovery?.postingHistory, incoming, new Date(observedAt))
    : { current: incoming, history: [] }
  const sameFingerprint = current?.id === incoming.id && current.fingerprint === incoming.fingerprint
  const next: Opportunity = {
    ...existing,
    deadline: observation.deadline ?? existing.deadline,
    salaryReference: observation.compensationText ?? existing.salaryReference,
    detail: {
      ...existing.detail,
      discovery: {
        sourceUrl: mergedPosting.current.sourceUrl,
        sourceTitle: mergedPosting.current.sourceTitle,
        location: observation.location ?? discovery?.location,
        compensationText: observation.compensationText ?? discovery?.compensationText,
        rationale: discovery?.rationale ?? observation.rationale,
        discoveredAt: discovery?.discoveredAt ?? observedAt,
        fitConfidence: discovery?.fitConfidence ?? observation.fitConfidence,
        opportunityValueConfidence: discovery?.opportunityValueConfidence ?? observation.opportunityValueConfidence,
        profileWarnings: discovery?.profileWarnings,
        posting: mergedPosting.current,
        postingHistory: mergedPosting.history.length ? mergedPosting.history : undefined,
      },
    },
  }
  return { opportunity: next, changed: !sameFingerprint || Boolean(observation.deadline && observation.deadline !== existing.deadline) }
}

function monitorFingerprint(observation: MonitorJobObservation) {
  return stableIngestionHash(JSON.stringify([
    observation.company,
    observation.role,
    observation.sourceUrl,
    observation.location ?? '',
    observation.deadline ?? '',
    observation.compensationText ?? '',
    observation.postingStatus ?? 'unknown',
  ]))
}

function standardOpportunityTimeline(opportunity: Opportunity, observedAt: string, sourceRef: string): TimelineRecord {
  return {
    id: `timeline:auto-opportunity:${opportunity.id}:${stableIngestionHash(sourceRef)}`,
    kind: 'opportunity_added',
    category: 'opportunity',
    source: 'automation',
    occurredAt: observedAt,
    recordedAt: observedAt,
    title: `监控自动加入机会｜${opportunity.company}｜${opportunity.role}`,
    opportunityId: opportunity.id,
    company: opportunity.company,
    role: opportunity.role,
    sourceRef,
  }
}

function completedResult(
  snapshot: PJSDASSnapshot,
  run: IngestionRunSummary,
): AutonomousIngestionResult {
  return {
    snapshot,
    run,
    records: [],
    alreadyApplied: true,
    createdOpportunityIds: [],
    touchedOpportunityIds: [],
    processEventIds: [],
  }
}

export function applyMonitorIngestion(
  snapshot: PJSDASSnapshot,
  input: MonitorIngestionRunInput,
): AutonomousIngestionResult {
  validateSnapshot(snapshot)
  const existingRun = runAlreadyApplied(snapshot, 'gpt_monitor', input.sourceId, input.runId)
  if (existingRun) return completedResult(snapshot, existingRun)

  if (!input.runId.trim() || !input.sourceId.trim()) throw new Error('Monitor ingestion requires stable runId and sourceId.')
  if (!validIso(input.startedAt) || !validIso(input.completedAt)) throw new Error('Monitor ingestion run timestamps are invalid.')
  if (input.observations.length > 100) throw new Error('Monitor ingestion accepts at most 100 observations per run.')

  const next = structuredClone(snapshot)
  const timeline = [...(next.data.timeline ?? [])]
  const runRecords: TimelineRecord[] = []
  const createdOpportunityIds: string[] = []
  const touchedOpportunityIds: string[] = []
  const profile = discoveryProfileForSnapshot(next.data.discoveryProfile)
  const rules = decisionRulesForSnapshot(next.data.decisionRules)
  const now = new Date(input.completedAt)

  for (const observation of input.observations) {
    const receivedAt = observation.discoveredAt ?? input.completedAt
    const fingerprint = monitorFingerprint(observation)
    const prior = alreadyIngested(timeline, {
      sourceKind: 'gpt_monitor', sourceId: input.sourceId, sourceRecordId: observation.sourceRecordId,
    })

    let outcome: 'created' | 'merged' | 'duplicate' | 'filtered' | 'unresolved' = 'unresolved'
    let reason: string | undefined
    let opportunityId: string | undefined

    if (!observation.sourceRecordId.trim() || !observation.company.trim() || !observation.role.trim() || !validIso(receivedAt)) {
      reason = '缺少稳定来源 ID、公司、岗位或有效发现时间。'
    } else if (prior?.ingestion?.outcome && prior.ingestion.outcome !== 'unresolved') {
      outcome = 'duplicate'
      opportunityId = prior.ingestion.opportunityId
      reason = `来源记录 ${observation.sourceRecordId} 已在先前 run 对账。`
    } else {
      try {
        const evaluated = evaluateDiscoveryCandidate(profile, {
          ...observation,
          discoveredAt: receivedAt,
        }, rules.weights, now)
        if (!evaluated.accepted) {
          outcome = 'filtered'
          reason = evaluated.hardRejectReasons.join('；')
        } else {
          const existing = findSimilarOpportunity(observation, next.data.opportunities)
          if (existing) {
            const merged = mergeMonitorObservation(existing, observation, receivedAt)
            opportunityId = existing.id
            const index = next.data.opportunities.findIndex((item) => item.id === existing.id)
            next.data.opportunities[index] = merged.opportunity
            outcome = merged.changed ? 'merged' : 'duplicate'
            if (merged.changed) touchedOpportunityIds.push(existing.id)
            reason = merged.changed ? '已归并到现有逻辑岗位并更新来源证据。' : '现有逻辑岗位已包含相同来源事实。'
          } else {
            const opportunity = createMonitorOpportunity(observation, receivedAt)
            next.data.opportunities.push(opportunity)
            next.data.actions.push(applyActionForNewOpportunity(opportunity, receivedAt))
            opportunityId = opportunity.id
            outcome = 'created'
            createdOpportunityIds.push(opportunity.id)
            touchedOpportunityIds.push(opportunity.id)
            timeline.push(standardOpportunityTimeline(opportunity, receivedAt, observation.sourceUrl))
          }
        }
      } catch (caught) {
        outcome = 'unresolved'
        reason = caught instanceof Error ? caught.message : String(caught)
      }
    }

    const record = createIngestionLedgerTimeline({
      sourceKind: 'gpt_monitor',
      sourceId: input.sourceId,
      sourceRecordId: observation.sourceRecordId || `missing:${runRecords.length}`,
      runId: input.runId,
      recordType: 'job_observation',
      outcome,
      fingerprint,
      receivedAt: validIso(receivedAt) ? receivedAt : input.completedAt,
      accountedAt: input.completedAt,
      reason,
      opportunityId,
      company: observation.company,
      role: observation.role,
      sourceRef: observation.sourceUrl,
    })
    runRecords.push(record)
    timeline.push(record)
  }

  const run = buildIngestionRunSummary({
    runId: input.runId,
    sourceKind: 'gpt_monitor',
    sourceId: input.sourceId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    records: runRecords,
  })
  timeline.push(createIngestionRunTimeline(run))
  next.data.timeline = withTimeline([], timeline)
  next.exportedAt = input.completedAt
  validateSnapshot(next)
  return {
    snapshot: next,
    run,
    records: runRecords,
    alreadyApplied: false,
    createdOpportunityIds,
    touchedOpportunityIds: [...new Set(touchedOpportunityIds)],
    processEventIds: [],
  }
}

function stageLabel(stage: ProcessStage) {
  const labels: Record<ProcessStage, string> = {
    not_applied: '待投', screening: '筛选中', assessment: '测评', written_test: '笔试',
    interview: '面试', offer: 'Offer', waiting_release: '等待开放', closed: '流程结束',
  }
  return labels[stage]
}

function gmailOpportunityId(company: string, role: string) {
  return `gmail-opportunity:${stableIngestionHash(jobIdentityKey(company, role))}`
}

function gmailEventId(sourceId: string, message: GmailMessageObservation) {
  return `gmail-event:${stableIngestionHash(`${sourceId}|${message.sourceRecordId}|${message.eventType ?? 'status_update'}`)}`
}

function effectiveMessageStage(message: GmailMessageObservation) {
  return message.stage ?? (message.eventType ? stageForProcessEvent(message.eventType) : undefined) ?? 'screening'
}

function createGmailShellOpportunity(message: GmailMessageObservation): Opportunity {
  const stage = effectiveMessageStage(message)
  return {
    id: gmailOpportunityId(message.company!, message.role!),
    company: message.company!.trim(),
    role: message.role!.trim(),
    currentStageLabel: message.stageLabel?.trim() || stageLabel(stage),
    processStage: stage,
    roleType: message.roleType ?? 'core',
    early: false,
    sourcePriority: 'Gmail 自动摄入 · 待补评估',
    nextActionLabel: stage === 'closed' ? '流程已结束' : '根据邮件进展继续流程',
    opportunityValue: message.opportunityValue ?? 50,
    fitScore: message.fitScore ?? 50,
    locallyManaged: true,
    importedAt: message.receivedAt,
    detail: { backgroundTag: 'Gmail 自动摄入；Fit / 机会价值尚未正式评估。' },
  }
}

function createGmailEvent(opportunity: Opportunity, sourceId: string, message: GmailMessageObservation): ProcessEvent | undefined {
  if (!message.eventType) return undefined
  const event: ProcessEvent = {
    id: gmailEventId(sourceId, message),
    opportunityId: opportunity.id,
    company: opportunity.company,
    role: opportunity.role,
    type: message.eventType,
    occurredAt: message.receivedAt,
    dueAt: message.dueAt,
    timingMode: message.timingMode,
    estimatedMinutes: message.estimatedMinutes,
    notes: message.notes?.trim() || undefined,
    source: 'email',
    createdAt: message.receivedAt,
    updatedAt: message.receivedAt,
  }
  return event
}

function gmailFingerprint(message: GmailMessageObservation) {
  return stableIngestionHash(JSON.stringify([
    message.sourceRecordId,
    message.classification,
    message.company ?? '',
    message.role ?? '',
    message.eventType ?? '',
    message.stage ?? '',
    message.dueAt ?? '',
    message.subject ?? '',
  ]))
}

export function applyGmailIngestion(
  snapshot: PJSDASSnapshot,
  input: GmailIngestionRunInput,
): AutonomousIngestionResult {
  validateSnapshot(snapshot)
  const existingRun = runAlreadyApplied(snapshot, 'gmail', input.sourceId, input.runId)
  if (existingRun) return completedResult(snapshot, existingRun)

  if (!input.runId.trim() || !input.sourceId.trim()) throw new Error('Gmail ingestion requires stable runId and sourceId.')
  if (!validIso(input.startedAt) || !validIso(input.completedAt)) throw new Error('Gmail ingestion run timestamps are invalid.')
  if (input.messages.length > 100) throw new Error('Gmail ingestion accepts at most 100 messages per run.')

  const next = structuredClone(snapshot)
  const timeline = [...(next.data.timeline ?? [])]
  const runRecords: TimelineRecord[] = []
  const createdOpportunityIds: string[] = []
  const touchedOpportunityIds: string[] = []
  const processEventIds: string[] = []

  for (const message of input.messages) {
    const fingerprint = gmailFingerprint(message)
    const prior = alreadyIngested(timeline, {
      sourceKind: 'gmail', sourceId: input.sourceId, sourceRecordId: message.sourceRecordId,
    })
    let outcome: 'created' | 'updated' | 'duplicate' | 'ignored' | 'unresolved' = 'unresolved'
    let reason: string | undefined
    let opportunityId: string | undefined
    let processEventId: string | undefined
    let actionId: string | undefined

    if (!message.sourceRecordId.trim() || !validIso(message.receivedAt)) {
      reason = 'Gmail message 缺少稳定 message id 或有效 receivedAt。'
    } else if (prior?.ingestion?.outcome && prior.ingestion.outcome !== 'unresolved') {
      outcome = 'duplicate'
      opportunityId = prior.ingestion.opportunityId
      processEventId = prior.ingestion.processEventId
      actionId = prior.ingestion.actionId
      reason = `Gmail message ${message.sourceRecordId} 已在先前 run 对账。`
    } else if (message.classification === 'ignored') {
      outcome = 'ignored'
      reason = '邮件被明确分类为非招聘事实。'
    } else if (message.confidence !== 'high' || !message.company?.trim() || !message.role?.trim()) {
      outcome = 'unresolved'
      reason = '招聘邮件身份或事件置信度不足；已保留异常，不自动猜测岗位。'
    } else {
      let opportunity = findSimilarOpportunity({ company: message.company, role: message.role }, next.data.opportunities)
      let created = false
      if (!opportunity) {
        opportunity = createGmailShellOpportunity(message)
        next.data.opportunities.push(opportunity)
        createdOpportunityIds.push(opportunity.id)
        created = true
      }
      opportunityId = opportunity.id

      if (message.stage) {
        const index = next.data.opportunities.findIndex((item) => item.id === opportunity!.id)
        next.data.opportunities[index] = {
          ...next.data.opportunities[index],
          processStage: message.stage,
          currentStageLabel: message.stageLabel?.trim() || stageLabel(message.stage),
          locallyManaged: true,
        }
        touchedOpportunityIds.push(opportunity.id)
      }

      const event = createGmailEvent(opportunity, input.sourceId, message)
      if (event) {
        const existingEvent = next.data.processEvents.find((item) => item.id === event.id)
        if (!existingEvent) {
          next.data.processEvents.push(event)
          processEventId = event.id
          processEventIds.push(event.id)
          const action = actionForProcessEvent(event)
          if (action && !next.data.actions.some((item) => item.id === action.id)) {
            next.data.actions.push(action)
            actionId = action.id
          } else if (action) actionId = action.id
          timeline.push(timelineFromProcessEvent(event, 'gmail', input.completedAt))
          touchedOpportunityIds.push(opportunity.id)
          outcome = created ? 'created' : 'updated'
          reason = created ? '从高置信招聘邮件创建岗位并记录流程事件。' : `已自动记录 ${processEventStageLabel(event)} 流程事实。`
        } else {
          processEventId = existingEvent.id
          actionId = actionForProcessEvent(existingEvent)?.id
          outcome = created ? 'created' : 'duplicate'
          reason = created ? '创建岗位；流程事件已存在。' : '相同 Gmail 流程事件已存在。'
        }
      } else if (message.stage) {
        outcome = created ? 'created' : 'updated'
        reason = created ? '从高置信招聘邮件创建岗位状态。' : '按高置信邮件更新岗位流程阶段。'
      } else {
        outcome = 'unresolved'
        reason = '识别为招聘邮件，但没有足够结构化的流程事件或阶段可安全写入。'
      }
    }

    const record = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: input.sourceId,
      sourceRecordId: message.sourceRecordId || `missing:${runRecords.length}`,
      runId: input.runId,
      recordType: 'recruiting_message',
      outcome,
      fingerprint,
      receivedAt: validIso(message.receivedAt) ? message.receivedAt : input.completedAt,
      accountedAt: input.completedAt,
      reason,
      opportunityId,
      processEventId,
      actionId,
      company: message.company,
      role: message.role,
      sourceRef: `gmail:${message.sourceRecordId}`,
    })
    runRecords.push(record)
    timeline.push(record)
  }

  const run = buildIngestionRunSummary({
    runId: input.runId,
    sourceKind: 'gmail',
    sourceId: input.sourceId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    cursor: input.cursor,
    records: runRecords,
  })
  timeline.push(createIngestionRunTimeline(run))
  next.data.timeline = withTimeline([], timeline)
  next.exportedAt = input.completedAt
  validateSnapshot(next)
  return {
    snapshot: next,
    run,
    records: runRecords,
    alreadyApplied: false,
    createdOpportunityIds,
    touchedOpportunityIds: [...new Set(touchedOpportunityIds)],
    processEventIds,
  }
}
