import { restoreProgressOperation } from './changeSet.js'
import { actionForProcessEvent } from './processEvents.js'
import { timelineFromChangeSetApplied, timelineFromProgressOperation } from './timeline.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import type { McpProposalEnvelope } from './ai/mcpProposal.js'
import type { Action, Opportunity, ProcessRecord } from './model.js'

// Apply a reviewed natural-language ChangeSet to one authoritative snapshot.
// The signed proposal and exact account/revision/fingerprint are checked by the gateway.
export function applyMcpProgressCommand(snapshot: PJSDASSnapshot, proposal: McpProposalEnvelope, now = new Date()) {
  const changeSet = proposal.changeSet
  if (changeSet.source !== 'mcp' || changeSet.status !== 'pending' || !changeSet.operations.length ||
    changeSet.operations.some((item) => item.kind !== 'progress_update')) {
    throw new Error('Only a pending independent MCP progress proposal can use this command.')
  }
  const next = upgradeSnapshotToLatest(snapshot)
  const data = next.data
  if ((data.changeSets ?? []).some((item) => item.id === changeSet.id)) {
    throw new Error('The signed proposal ChangeSet ID conflicts with existing workspace history.')
  }
  const ids = new Set<string>()
  const upsertProcess = (opportunity: Opportunity, stage: ProcessRecord['stage'], stageLabel: string, occurredAt: string) => {
    const found = data.processes.filter((item) => item.opportunityId === opportunity.id)
    if (found.length) {
      data.processes = data.processes.map((item) => item.opportunityId === opportunity.id ? {
        ...item, company: opportunity.company, role: opportunity.role, stage, stageLabel,
        lastProgressAt: occurredAt, nextCheckAt: undefined, silenceRisk: undefined,
        currentAction: undefined, locallyManaged: true,
      } : item)
    } else data.processes.push({
      id: `local-process:${opportunity.id}`, opportunityId: opportunity.id,
      company: opportunity.company, role: opportunity.role, stage, stageLabel,
      lastProgressAt: occurredAt, locallyManaged: true,
    })
  }
  for (const item of changeSet.operations) {
    if (item.kind !== 'progress_update') throw new Error('Progress proposal contains another operation type.')
    const operation = restoreProgressOperation(item, changeSet.id)
    if (ids.has(operation.id)) throw new Error('Progress proposal repeats an operation ID.')
    ids.add(operation.id)
    const before = 'opportunityId' in operation
      ? data.opportunities.find((opportunity) => opportunity.id === operation.opportunityId)
      : undefined

    if (operation.kind === 'upsert_opportunity') {
      const submitted = operation.mode === 'submitted'
      const opportunity: Opportunity = before ? {
        ...before, company: operation.company, role: operation.role,
        currentStageLabel: submitted ? '筛选中' : before.currentStageLabel,
        processStage: submitted ? 'screening' : before.processStage, locallyManaged: true,
      } : {
        id: operation.opportunityId, company: operation.company, role: operation.role,
        currentStageLabel: submitted ? '筛选中' : '待投',
        processStage: submitted ? 'screening' : 'not_applied', roleType: 'core',
        early: false, opportunityValue: 86, fitScore: 60, locallyManaged: true,
        importedAt: operation.occurredAt,
      }
      data.opportunities = [...data.opportunities.filter((item) => item.id !== opportunity.id), opportunity]
      const applyId = `apply:${opportunity.id}`
      const existingApply = data.actions.find((action) => action.id === applyId)
      if (submitted) {
        if (existingApply && (existingApply.status === 'todo' || existingApply.status === 'doing')) {
          data.actions = data.actions.map((action) => action.id === applyId
            ? { ...action, status: 'done' as const, updatedAt: operation.occurredAt } : action)
        }
        upsertProcess(opportunity, 'screening', '筛选中', operation.occurredAt)
      } else if (!existingApply) data.actions.push({
        id: applyId, kind: 'apply', title: `投递 ${opportunity.company}｜${opportunity.role}`,
        opportunityId: opportunity.id, estimatedMinutes: 45, leverage: 86, delayCost: 40,
        status: 'todo', sourceLabel: '自然语言更新',
        createdAt: operation.occurredAt, updatedAt: operation.occurredAt,
      })
    } else if (operation.kind === 'rename_opportunity') {
      if (!before || before.role !== operation.oldRole) throw new Error('The named Opportunity changed since review.')
      data.opportunities = data.opportunities.map((opportunity) => opportunity.id === before.id
        ? { ...opportunity, company: operation.company, role: operation.newRole, locallyManaged: true } : opportunity)
      data.processes = data.processes.map((process) => process.opportunityId === before.id
        ? { ...process, company: operation.company, role: operation.newRole, locallyManaged: true } : process)
      data.actions = data.actions.map((action) => action.opportunityId === before.id ? {
        ...action, title: action.title.includes(operation.oldRole)
          ? action.title.replace(operation.oldRole, operation.newRole) : action.title,
        updatedAt: operation.occurredAt,
      } : action)
    } else if (operation.kind === 'close_opportunity') {
      if (!before) throw new Error('The closing Opportunity is missing from the account workspace.')
      const opportunity: Opportunity = { ...before, currentStageLabel: '流程结束', processStage: 'closed', locallyManaged: true }
      data.opportunities = data.opportunities.map((item) => item.id === before.id ? opportunity : item)
      upsertProcess(opportunity, 'closed', '流程结束', operation.occurredAt)
      data.actions = data.actions.map((action) => action.opportunityId === before.id && action.kind !== 'prep' &&
        (action.status === 'todo' || action.status === 'doing')
        ? { ...action, status: 'skipped' as const, updatedAt: operation.occurredAt } : action)
    } else if (operation.kind === 'process_event') {
      if (!before) throw new Error('The Process Event Opportunity is missing from the account workspace.')
      const eventId = `progress-event:${operation.id}`
      const previous = data.processEvents.find((event) => event.id === eventId)
      const event = {
        id: eventId, opportunityId: operation.opportunityId,
        company: operation.company, role: operation.role, type: operation.eventType,
        occurredAt: operation.occurredAt, dueAt: operation.dueAt,
        timingMode: operation.timingMode, estimatedMinutes: operation.estimatedMinutes,
        source: 'manual' as const, createdAt: previous?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      }
      data.processEvents = [...data.processEvents.filter((item) => item.id !== eventId), event]
      const generated = actionForProcessEvent(event)
      if (generated) {
        const prior = data.actions.find((action) => action.id === generated.id)
        const action: Action = operation.completed
          ? { ...generated, status: 'done', updatedAt: operation.occurredAt }
          : prior ? { ...generated, status: prior.status, updatedAt: prior.updatedAt } : generated
        data.actions = [...data.actions.filter((item) => item.id !== action.id), action]
      }
    } else if (operation.kind === 'manual_action') {
      const actionId = `progress-action:${operation.id}`
      const prior = data.actions.find((action) => action.id === actionId)
      const action: Action = {
        id: actionId, kind: 'manual', title: operation.title, dueAt: operation.dueAt,
        estimatedMinutes: operation.estimatedMinutes, leverage: 70,
        delayCost: operation.dueAt ? 65 : 40, status: prior?.status ?? 'todo',
        sourceLabel: '自然语言更新', createdAt: prior?.createdAt ?? operation.occurredAt,
        updatedAt: prior?.updatedAt ?? operation.occurredAt,
      }
      data.actions = [...data.actions.filter((item) => item.id !== action.id), action]
    }
    const timeline = timelineFromProgressOperation(operation, before)
    if (timeline) data.timeline = [...(data.timeline ?? []).filter((item) => item.id !== timeline.id), timeline]
  }
  const timestamp = now.toISOString()
  const applied = { ...changeSet, status: 'applied' as const, appliedAt: timestamp, updatedAt: timestamp }
  data.changeSets = [...(data.changeSets ?? []), applied]
  data.timeline = [...(data.timeline ?? []), timelineFromChangeSetApplied(applied)]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return { status: 'APPLIED' as const, changed: true, snapshot: next,
    summary: `Applied ${changeSet.operations.length} reviewed progress updates.` }
}
