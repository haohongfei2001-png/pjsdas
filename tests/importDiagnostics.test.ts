import { describe, expect, it } from 'vitest'
import { assertImportBundleSafe, diagnoseImport } from '../src/importDiagnostics'
import type { ImportBundle } from '../src/model'

function bundle(): ImportBundle {
  return {
    opportunities: [
      {
        id: 'A-1',
        company: '测试公司',
        role: '产品经理',
        currentStageLabel: '待投',
        processStage: 'not_applied',
        roleType: 'core',
        early: false,
        opportunityValue: 94,
        fitScore: 76,
        detail: {},
        importedAt: new Date().toISOString(),
      },
    ],
    processes: [],
    actions: [],
    prep: [],
    applicationGroups: [],
    summary: {
      filename: 'test.xlsx',
      importedAt: new Date().toISOString(),
      opportunities: 1,
      pending: 1,
      processes: 0,
      prep: 0,
      applicationGroups: 0,
      actions: 0,
    },
  }
}

describe('import diagnostics', () => {
  it('blocks duplicate opportunity ids before database replacement', () => {
    const source = bundle()
    source.opportunities.push({ ...source.opportunities[0], role: '战略分析' })

    const diagnostics = diagnoseImport(source)
    expect(diagnostics.some((item) => item.code === 'duplicate-opportunity-id' && item.severity === 'error')).toBe(true)
    expect(() => assertImportBundleSafe(source)).toThrow(/岗位ID重复/)
  })

  it('warns when a main-table application group reference is orphaned', () => {
    const source = bundle()
    source.opportunities[0].applicationGroupId = 'MISSING-GROUP'

    const diagnostics = diagnoseImport(source)
    expect(diagnostics.some((item) => item.code === 'orphan-application-group' && item.severity === 'warning')).toBe(true)
    expect(() => assertImportBundleSafe(source)).not.toThrow()
  })

  it('reports constrained application groups as informational diagnostics', () => {
    const source = bundle()
    source.applicationGroups.push({ id: 'GROUP-1', company: '测试公司', remaining: 1 })
    source.actions.push({
      id: 'group:GROUP-1',
      kind: 'group_decision',
      title: '测试公司｜择一投递',
      applicationGroupId: 'GROUP-1',
      estimatedMinutes: 20,
      leverage: 90,
      delayCost: 70,
      status: 'todo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const diagnostics = diagnoseImport(source)
    expect(diagnostics.find((item) => item.code === 'constrained-application-groups')?.count).toBe(1)
  })
})
