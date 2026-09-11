import { describe, expect, it } from 'vitest'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import { createOpportunityFacts } from '../src/richOpportunity.js'
import { createSnapshot } from '../src/snapshot.js'
import type { Opportunity } from '../src/model.js'

function opportunity(detail?: Opportunity['detail']): Opportunity {
  return {
    id: 'rich-snapshot-1',
    company: '快照科技',
    role: 'AI 产品经理',
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 86,
    fitScore: 82,
    importedAt: '2026-09-12T08:00:00.000Z',
    detail,
  }
}

function data(opportunities: Opportunity[]) {
  return {
    opportunities,
    processes: [],
    processEvents: [],
    actions: [],
    prep: [],
    applicationGroups: [],
  }
}

describe('v1.5 Round 1 Rich Opportunity snapshots', () => {
  it('keeps old snapshot-v1 Opportunities without facts valid', () => {
    expect(() => createSnapshot(data([opportunity()]), '2026-09-12T09:00:00.000Z')).not.toThrow()
  })

  it('validates Rich Opportunity facts inside normal snapshot validation', () => {
    const facts = createOpportunityFacts({
      sourceUrl: 'https://careers.example.com/snapshot-rich',
      sourceTitle: '快照科技 AI 产品经理',
      verifiedAt: '2026-09-12T08:00:00.000Z',
      location: '北京',
      facts: { responsibilities: ['负责 AI 产品规划'] },
    })
    expect(() => createSnapshot(data([opportunity({ facts })]), '2026-09-12T09:00:00.000Z')).not.toThrow()

    const corrupted = { ...facts, unknownFields: [] }
    expect(() => createSnapshot(data([opportunity({ facts: corrupted })]), '2026-09-12T09:00:00.000Z')).toThrow(/Rich Opportunity/)
  })

  it('includes Rich Opportunity facts in the workspace conflict fingerprint', async () => {
    const firstFacts = createOpportunityFacts({
      sourceUrl: 'https://careers.example.com/snapshot-rich',
      sourceTitle: '快照科技 AI 产品经理',
      verifiedAt: '2026-09-12T08:00:00.000Z',
      facts: { skills: ['SQL'] },
    })
    const secondFacts = createOpportunityFacts({
      sourceUrl: 'https://careers.example.com/snapshot-rich',
      sourceTitle: '快照科技 AI 产品经理',
      verifiedAt: '2026-09-12T08:00:00.000Z',
      facts: { skills: ['SQL', 'Python'] },
    })
    const first = createSnapshot(data([opportunity({ facts: firstFacts })]), '2026-09-12T09:00:00.000Z')
    const second = createSnapshot(data([opportunity({ facts: secondFacts })]), '2026-09-12T09:00:00.000Z')
    await expect(fingerprintWorkspace(first)).resolves.not.toBe(await fingerprintWorkspace(second))
  })
})
