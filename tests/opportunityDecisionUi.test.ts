import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const read = readFileSync(new URL('../src/opportunityDecisionRead.ts', import.meta.url), 'utf8')
const list = readFileSync(new URL('../src/jobs/JobLibrary.tsx', import.meta.url), 'utf8')
const detail = readFileSync(new URL('../src/OpportunityDetailDrawer.tsx', import.meta.url), 'utf8')
const server = readFileSync(new URL('../gateway/serverFactory.ts', import.meta.url), 'utf8')

describe('UU-05 frozen opportunity product contract', () => {
  it('keeps exact opportunity identity and one truthful job-status filter', () => {
    expect(read).toContain("export type OpportunityDecisionBucket = 'in_progress' | 'worth_pursuing' | 'ended'")
    expect(list).toContain("['all', '全部', 'All']")
    expect(list).toContain("['unapplied', '待投递', 'To apply']")
    expect(list).toContain("['in_progress', '推进中', 'In progress']")
    expect(list).toContain("['ended', '已结束', 'Ended']")
    expect(list).toContain('key={item.opportunityId}')
    expect(list).toContain('onOpenOpportunity(item.opportunityId)')
  })

  it('uses the same ranking semantics as Today for next actions', () => {
    expect(read).toContain('rankActions(snapshot.data.actions, snapshot.data.opportunities')
    expect(app).toContain('buildOpportunityDecisionList(snapshot')
    expect(app).toContain('getOpportunityDecisionRead(snapshot')
  })

  it('keeps progressive evidence/assessment/history behind the conclusion-first layer', () => {
    expect(detail).toContain('<RichOpportunityFactsSummary')
    expect(detail).toContain("zh ? '申请约束' : 'Application constraints'")
    expect(detail).toContain("zh ? '准备与相关待办' : 'Preparation & related actions'")
    expect(detail).toContain("zh ? '来源证据' : 'Source evidence'")
    expect(detail).toContain('<OpportunityAssessmentSummary')
    expect(detail).toContain("zh ? '完整历史' : 'Full history'")
  })

  it('exposes the platform-neutral conclusion-first detail through the read-only MCP surface', () => {
    expect(server).toContain("server.registerTool('get_opportunity_detail'")
    expect(server).toContain('canonical opportunity decision read')
  })
})
