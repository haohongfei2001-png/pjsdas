import { describe, expect, it } from 'vitest'
import { createSnapshot } from '../src/snapshot.js'
import { DEFAULT_DECISION_RULES } from '../src/decisionRules.js'
import { canonicalWorkspaceJson, fingerprintWorkspace, workspaceIsEffectivelyEmpty } from '../src/cloud/workspaceFingerprint.js'

function snapshot(exportedAt: string, company?: string) {
  return createSnapshot({
    opportunities: company ? [{
      id: 'role-1', company, role: 'Product', currentStageLabel: '待投', processStage: 'not_applied', roleType: 'core', early: false,
      opportunityValue: 80, fitScore: 60, importedAt: '2026-09-11T00:00:00.000Z',
    }] : [],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
    decisionRules: { ...DEFAULT_DECISION_RULES, weights: { ...DEFAULT_DECISION_RULES.weights } },
    timeline: [], changeSets: [],
  }, exportedAt)
}

describe('cloud workspace fingerprint', () => {
  it('ignores snapshot export time', async () => {
    const a = snapshot('2026-09-11T00:00:00.000Z', 'Example')
    const b = snapshot('2026-09-12T00:00:00.000Z', 'Example')
    expect(canonicalWorkspaceJson(a)).toBe(canonicalWorkspaceJson(b))
    expect(await fingerprintWorkspace(a)).toBe(await fingerprintWorkspace(b))
  })

  it('changes when workspace data changes', async () => {
    expect(await fingerprintWorkspace(snapshot('2026-09-11T00:00:00.000Z', 'A')))
      .not.toBe(await fingerprintWorkspace(snapshot('2026-09-11T00:00:00.000Z', 'B')))
  })

  it('recognizes an untouched empty local workspace', () => {
    expect(workspaceIsEffectivelyEmpty(snapshot('2026-09-11T00:00:00.000Z'))).toBe(true)
    expect(workspaceIsEffectivelyEmpty(snapshot('2026-09-11T00:00:00.000Z', 'A'))).toBe(false)
  })
})
