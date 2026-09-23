import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const detail = readFileSync(new URL('../src/OpportunityDetailDrawer.tsx', import.meta.url), 'utf8')
const list = readFileSync(new URL('../src/OpportunityDecisionList.tsx', import.meta.url), 'utf8')
const summary = readFileSync(new URL('../src/OpportunityDecisionSummary.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/opportunityDecision.css', import.meta.url), 'utf8')
const ultimateCss = readFileSync(new URL('../src/ultimateWeb.css', import.meta.url), 'utf8')

describe('UU-05 opportunity decision/detail integration', () => {
  it('uses one shared decision read model across list and detail instead of table/pipeline maintenance views', () => {
    expect(app).toContain('buildOpportunityDecisionList')
    expect(app).toContain('getOpportunityDecisionRead')
    expect(app).toContain('<OpportunityDecisionList')
    expect(app).toContain('<OpportunityDetailDrawer')
    expect(app).not.toContain('function OpportunityTable')
    expect(app).not.toContain('function PipelinePanel')
    expect(list).toContain("export type OpportunityListView = 'in_progress' | 'worth_pursuing' | 'all' | 'ended'")
    expect(app).toContain("useState<OpportunityListView>('in_progress')")
    expect(detail).toContain('<OpportunityDecisionSummary')
  })

  it('keeps the frozen conclusion-first order and hides assessment internals from the default first screen', () => {
    expect(summary).toContain("zh ? '结论' : 'CONCLUSION'")
    expect(summary).toContain('opportunity-detail-decision-reasons')
    expect(summary).toContain('opportunity-detail-process-summary')
    expect(summary).toContain('opportunity-detail-primary-operation')
    expect(summary).toContain('opportunity-detail-nearest-node')
    expect(detail.indexOf('<OpportunityDecisionSummary')).toBeLessThan(detail.indexOf('<RichOpportunityFactsSummary'))
    expect(detail.indexOf('<RichOpportunityFactsSummary')).toBeLessThan(detail.indexOf('<OpportunityAssessmentSummary'))
    expect(detail).not.toContain('opportunity-detail-score-grid')
    expect(detail).not.toContain('OPPORTUNITY · {opportunity.id}')
  })

  it('keeps Fit/Value/quota implementation detail out of the default list rows', () => {
    expect(list).not.toContain('fitScore')
    expect(list).not.toContain('opportunityValue')
    expect(list).not.toContain('applicationGroupId')
    expect(list).toContain('item.nextAction?.title')
    expect(list).toContain('item.nearestNode')
    expect(list).toContain('presentStageLabel')
    expect(css).toContain('.opportunity-decision-row')
  })

  it('keeps iPhone access on the same two stable destinations and makes decision rows responsive', () => {
    expect(ultimateCss).toContain('grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(css).toContain('@media(max-width:760px)')
    expect(css).toContain('.opportunity-decision-row{display:flex')
  })
})
