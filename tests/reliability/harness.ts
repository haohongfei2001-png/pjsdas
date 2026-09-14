import { createDefaultDecisionRules } from '../../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../../src/discoveryProfile.js'
import { createSnapshot, type PJSDASSnapshot } from '../../src/snapshot.js'
import { auditWorkspaceIntegrity } from '../../src/workspaceIntegrity.js'
import type { Action, Opportunity } from '../../src/model.js'

export const RELIABILITY_EPOCH = '2026-09-14T00:00:00.000Z'
export const RELIABILITY_NOW = new Date('2026-09-14T12:00:00.000Z')

export function reliabilityOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'opp-default',
    company: '示例科技',
    role: 'AI产品经理',
    currentStageLabel: '筛选中',
    processStage: 'screening',
    roleType: 'core',
    early: false,
    opportunityValue: 80,
    fitScore: 75,
    locallyManaged: true,
    importedAt: RELIABILITY_EPOCH,
    ...overrides,
  }
}

export function reliabilityAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 'action-default',
    kind: 'manual',
    title: '示例任务',
    opportunityId: 'opp-default',
    estimatedMinutes: 30,
    leverage: 50,
    delayCost: 50,
    status: 'todo',
    createdAt: RELIABILITY_EPOCH,
    updatedAt: RELIABILITY_EPOCH,
    ...overrides,
  }
}

export function reliabilitySnapshot(input: {
  opportunities?: Opportunity[]
  actions?: Action[]
} = {}): PJSDASSnapshot {
  return createSnapshot({
    opportunities: input.opportunities ?? [],
    processes: [],
    processEvents: [],
    actions: input.actions ?? [],
    prep: [],
    applicationGroups: [],
    decisionRules: createDefaultDecisionRules(RELIABILITY_EPOCH),
    discoveryProfile: createDefaultDiscoveryProfile(RELIABILITY_EPOCH),
    discoveryInbox: [],
    timeline: [],
    changeSets: [],
  }, RELIABILITY_EPOCH)
}

function compareStable(a: unknown, b: unknown) {
  return JSON.stringify(a).localeCompare(JSON.stringify(b))
}

function normalizedOutcomes(outcomes: Record<string, number | undefined>) {
  return Object.fromEntries(
    Object.entries(outcomes)
      .filter(([, value]) => Boolean(value))
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

/**
 * Project a workspace into stable business semantics rather than volatile IDs.
 * This is intentionally narrower than a whole-snapshot serialization: internal
 * refactors should not churn goldens unless the user-visible / durable outcome changes.
 */
export function projectReliabilityState(snapshot: PJSDASSnapshot, now = RELIABILITY_NOW) {
  const integrity = auditWorkspaceIntegrity(snapshot, now)
  return {
    opportunities: snapshot.data.opportunities
      .map((item) => ({
        company: item.company,
        role: item.role,
        location: item.detail?.discovery?.location,
        processStage: item.processStage,
        canonicalSourceUrl: item.detail?.discovery?.posting?.canonicalSourceUrl,
      }))
      .sort(compareStable),
    processEvents: snapshot.data.processEvents
      .map((item) => ({
        company: item.company,
        role: item.role,
        type: item.type,
        dueAt: item.dueAt,
        timingMode: item.timingMode,
      }))
      .sort(compareStable),
    actions: snapshot.data.actions
      .map((item) => ({
        kind: item.kind,
        status: item.status,
        processStage: item.processStage,
        dueAt: item.dueAt,
        eventLinked: Boolean(item.processEventId),
      }))
      .sort(compareStable),
    ingestionRuns: (snapshot.data.timeline ?? [])
      .filter((item) => Boolean(item.ingestionRun))
      .map((item) => ({
        sourceKind: item.ingestionRun!.sourceKind,
        sourceId: item.ingestionRun!.sourceId,
        runId: item.ingestionRun!.runId,
        receivedCount: item.ingestionRun!.receivedCount,
        accountedCount: item.ingestionRun!.accountedCount,
        outcomes: normalizedOutcomes(item.ingestionRun!.outcomes),
      }))
      .sort(compareStable),
    integrity: {
      status: integrity.status,
      criticalCount: integrity.criticalCount,
      warningCount: integrity.warningCount,
      issueCodes: integrity.issues.map((item) => item.code).sort(),
    },
  }
}
