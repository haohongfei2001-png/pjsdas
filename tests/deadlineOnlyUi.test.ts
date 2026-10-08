import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

describe('deadline-only product surfaces', () => {
  it('removes the decision-rule settings entry and editor rather than concealing controls', () => {
    const app = source('AppV8.tsx')
    expect(app).not.toMatch(/RulesView|DecisionRules|DEFAULT_DECISION_RULES|decisionRules/)
    expect(app).not.toContain('Decision policy')
    expect(existsSync(new URL('../src/RulesView.tsx', import.meta.url))).toBe(false)
    expect(app).toContain('DiscoveryProfileCard')
    expect(app).toContain('LocalBackupDock')
    expect(app).toContain('TimelineView')
  })

  it('removes all opportunity assessment renderers while retaining source-backed facts', () => {
    expect(existsSync(new URL('../src/OpportunityAssessmentSummary.tsx', import.meta.url))).toBe(false)
    for (const file of ['OpportunityDetailDrawer.tsx', 'DiscoveryInboxViewHeavy.tsx', 'aiAccess/McpProposalReview.tsx']) {
      const value = source(file)
      expect(value).not.toMatch(/OpportunityAssessmentSummary|fitScore|opportunityValue|fitConfidence|reviewScore|component assessment/i)
      expect(value).toContain('RichOpportunityFactsSummary')
      expect(value).toMatch(/sourceUrl|SourceRow/)
    }
    expect(source('OpportunityDetailDrawer.tsx')).toContain('orderedTimeline')
  })

  it('keeps status filters and one deadline order, without score-based discovery sort choices', () => {
    const inbox = source('DiscoveryInboxViewHeavy.tsx')
    expect(inbox).toContain('sortDiscoveryInboxItems(filtered)')
    expect(inbox).not.toMatch(/DiscoveryInboxSort|setSort|review_priority|completeness.*<option/)
    expect(inbox).toContain('item.status === filter')
    expect(inbox).toContain('bulkMutate')
    expect(inbox).toContain('promotePreview')
    const jobs = source('jobs/JobLibrary.tsx')
    expect(jobs).not.toMatch(/fitScore|opportunityValue|score|weight/)
    expect(jobs).toContain("['no_deadline', '无截止日期', 'No deadline']")
  })

  it('keeps factual discovery preferences and removes all minimum-score controls', () => {
    const profile = source('DiscoveryProfileCardHeavy.tsx')
    expect(profile).not.toMatch(/minimumFitScore|minimumOpportunityValue|匹配度|机会价值|score threshold/i)
    for (const field of ['searchGoal', 'targetRoleQueries', 'preferredLocations', 'mustHave', 'mustNotHave']) expect(profile).toContain(field)
    expect(profile).not.toMatch(/minimumAnnualCompensationWan|preferredRoleTypes|locationNotes|strengths|\.notes/)
  })

  it('shows real application quotas and stored choices with no automatic portfolio selection', () => {
    const portfolio = source('ApplicationPortfolioDockHeavy.tsx')
    expect(portfolio).not.toMatch(/buildAllApplicationPortfolioDecisions|getDecisionRules|baseScore|minimumScore|components\.|recommended|weights/)
    for (const field of ['group.total', 'group.used', 'group.remaining', 'group.currentOrder', 'group.rule', 'group.locked', 'candidate.order', 'candidate.roleType', 'candidate.deadline']) expect(portfolio).toContain(field)
    expect(portfolio).toContain('buildApplicationPortfolioDecision(group, opportunities')
  })

  it('retains preparation links and factual counts without leverage or priority scoring', () => {
    const graph = source('PrepGraphDockHeavy.tsx')
    expect(graph).not.toMatch(/leverageScore|urgencyScore|valueScore|need\.severity|highest-leverage/i)
    expect(graph).toContain('node.coverageCount')
    expect(graph).toContain('node.nextRelevantAt')
    expect(graph).toContain('link.confidence')
    const app = source('AppV8.tsx')
    expect(app).not.toMatch(/prepPriorityRank|presentPrepPriority/)
    expect(app).toContain('a.recentNodeAt')
  })
})
