import { buildApplicationPortfolioDecision } from '../applicationPortfolio.js'
import { decisionRulesForSnapshot } from '../decisionRules.js'
import { validateSnapshot, type PJSDASSnapshot } from '../snapshot.js'
import { BridgeReadError, type BridgeReadContext } from './readLayer.js'

export interface GetApplicationPortfolioInput {
  groupId?: string
  company?: string
  limit?: number
}

function resolvedContext(context: BridgeReadContext) {
  return {
    now: context.now ?? new Date(),
    timezone: context.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    workspaceVersion: context.workspaceVersion,
  }
}

export function getApplicationPortfolio(
  snapshot: PJSDASSnapshot,
  input: GetApplicationPortfolioInput = {},
  bridgeContext: BridgeReadContext = {},
) {
  try {
    validateSnapshot(snapshot)
  } catch (caught) {
    throw new BridgeReadError('WORKSPACE_INVALID', caught instanceof Error ? caught.message : 'PJSDAS workspace validation failed.')
  }

  const context = resolvedContext(bridgeContext)
  const limit = input.limit ?? 10
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new BridgeReadError('INVALID_ARGUMENT', 'limit must be an integer between 1 and 20.')
  }
  const groupId = input.groupId?.trim()
  const company = input.company?.trim().toLocaleLowerCase()
  const groups = snapshot.data.applicationGroups
    .filter((group) => !groupId || group.id === groupId)
    .filter((group) => !company || group.company.toLocaleLowerCase().includes(company))

  if (groupId && groups.length === 0) {
    throw new BridgeReadError('NOT_FOUND', `Application Group ${groupId} was not found.`)
  }

  const rules = decisionRulesForSnapshot(snapshot.data.decisionRules)
  const decisions = groups
    .map((group) => buildApplicationPortfolioDecision(group, snapshot.data.opportunities, rules, context.now))
    .sort((a, b) => {
      const order = { ready: 0, needs_rule_confirmation: 1, no_recommendation: 2, capacity_exhausted: 3, locked: 4, no_candidates: 5 }
      return order[a.status] - order[b.status] || a.company.localeCompare(b.company) || a.groupId.localeCompare(b.groupId)
    })

  return {
    meta: {
      workspaceVersion: context.workspaceVersion,
      generatedAt: context.now.toISOString(),
      timezone: context.timezone,
      source: 'pjsdas' as const,
    },
    decisions: decisions.slice(0, limit),
    truncated: decisions.length > limit,
    policy: {
      capacityIsMaximum: true,
      autoFillSlots: false,
      automaticApplication: false,
      minimumCandidateScore: rules.portfolioMinimumCandidateScore,
      portfolioWeights: rules.portfolioWeights,
    },
  }
}
