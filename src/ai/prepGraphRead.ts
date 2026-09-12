import { buildPrepGraph } from '../prepGraph.js'
import {
  overlayProcessEventsOnOpportunities,
  overlayProcessEventsOnProcesses,
  reconcileProcessEventActions,
  suppressSupersededActions,
} from '../processEvents.js'
import { validateSnapshot, type PJSDASSnapshot } from '../snapshot.js'

export interface PrepGraphReadInput {
  prepId?: string
  opportunityId?: string
  limit?: number
}

function normalizeLimit(value: number | undefined) {
  if (value === undefined) return 20
  if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error('limit must be an integer between 1 and 50.')
  return value
}

export function readPrepGraph(snapshot: PJSDASSnapshot, input: PrepGraphReadInput = {}, now = new Date()) {
  validateSnapshot(snapshot)
  const events = snapshot.data.processEvents
  const opportunities = overlayProcessEventsOnOpportunities(snapshot.data.opportunities, events, snapshot.data.processes)
  const actions = suppressSupersededActions(reconcileProcessEventActions(snapshot.data.actions, events), opportunities)
  const processes = overlayProcessEventsOnProcesses(snapshot.data.processes, opportunities, events, actions)
  const graph = buildPrepGraph(snapshot.data.prep, opportunities, processes, now)
  const limit = normalizeLimit(input.limit)
  const opportunityById = new Map(opportunities.map((item) => [item.id, item]))

  const nodes = graph.nodes
    .filter((node) => !input.prepId || node.prepId === input.prepId)
    .filter((node) => !input.opportunityId || node.coveredOpportunityIds.includes(input.opportunityId))
    .slice(0, limit)
    .map((node) => ({
      prepId: node.prepId,
      title: node.title,
      sourceStatus: node.sourceStatus,
      estimatedMinutes: node.estimatedMinutes,
      leverageScore: node.leverageScore,
      coverageCount: node.coverageCount,
      matchedNeedCount: node.matchedNeedCount,
      urgencyScore: node.urgencyScore,
      valueScore: node.valueScore,
      nextRelevantAt: node.nextRelevantAt,
      triggerSuggested: node.triggerSuggested,
      opportunities: node.coveredOpportunityIds.map((id) => {
        const opportunity = opportunityById.get(id)
        return {
          opportunityId: id,
          company: opportunity?.company,
          role: opportunity?.role,
          stage: opportunity?.processStage,
          opportunityValue: opportunity?.opportunityValue,
          fitScore: opportunity?.fitScore,
        }
      }),
      links: node.links.map((link) => ({
        opportunityId: link.opportunityId,
        source: link.source,
        confidence: link.confidence,
        explanation: link.explanation,
        matchedNeedIds: link.matchedNeedIds,
      })),
    }))

  const uncoveredNeeds = graph.uncoveredNeeds
    .filter((need) => !input.opportunityId || need.opportunityId === input.opportunityId)
    .slice(0, limit)
    .map((need) => ({
      needId: need.id,
      opportunityId: need.opportunityId,
      company: need.company,
      role: need.role,
      kind: need.kind,
      label: need.label,
      severity: need.severity,
      source: need.source,
    }))

  return {
    generatedAt: graph.generatedAt,
    summary: {
      prepNodes: graph.nodes.length,
      deterministicLinks: graph.links.length,
      linkedPrepNodes: graph.nodes.filter((node) => node.coverageCount > 0).length,
      triggerSuggestions: graph.nodes.filter((node) => node.triggerSuggested).length,
      uncoveredNeeds: graph.uncoveredNeeds.length,
    },
    nodes,
    uncoveredNeeds,
    policy: {
      explicitOrExactOnly: true,
      fuzzySemanticLinks: false,
      runtimeProjectionOnly: true,
      automaticTaskCreation: false,
      automaticMutation: false,
    },
  }
}
