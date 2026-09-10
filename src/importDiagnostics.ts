import type { ImportBundle } from './model'

export type ImportDiagnosticSeverity = 'error' | 'warning' | 'info'

export interface ImportDiagnostic {
  severity: ImportDiagnosticSeverity
  code: string
  message: string
  count: number
  samples?: string[]
}

function duplicates(values: string[]) {
  const seen = new Set<string>()
  const duplicate = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value)
    seen.add(value)
  }
  return [...duplicate]
}

export function diagnoseImport(bundle: ImportBundle): ImportDiagnostic[] {
  const diagnostics: ImportDiagnostic[] = []
  const opportunityIds = new Set(bundle.opportunities.map((item) => item.id))
  const groupIds = new Set(bundle.applicationGroups.map((item) => item.id))

  const duplicateOpportunityIds = duplicates(bundle.opportunities.map((item) => item.id))
  if (duplicateOpportunityIds.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'duplicate-opportunity-id',
      message: '岗位ID重复；继续导入会让后写入记录覆盖前记录。',
      count: duplicateOpportunityIds.length,
      samples: duplicateOpportunityIds.slice(0, 5),
    })
  }

  const duplicateActionIds = duplicates(bundle.actions.map((item) => item.id))
  if (duplicateActionIds.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'duplicate-action-id',
      message: '生成的Action ID重复；无法安全保存行动状态。',
      count: duplicateActionIds.length,
      samples: duplicateActionIds.slice(0, 5),
    })
  }

  const incomplete = bundle.opportunities
    .filter((item) => !item.id || !item.company || !item.role)
    .map((item) => item.id || '(blank id)')
  if (incomplete.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'incomplete-opportunity',
      message: '存在缺少岗位ID、公司或岗位名称的机会记录。',
      count: incomplete.length,
      samples: incomplete.slice(0, 5),
    })
  }

  const missingDetails = bundle.opportunities.filter((item) => !item.detail).map((item) => item.id)
  if (missingDetails.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'missing-job-detail',
      message: '部分岗位在“岗位详情”中没有对应记录；不会阻止导入，但详情能力会缺失。',
      count: missingDetails.length,
      samples: missingDetails.slice(0, 5),
    })
  }

  const orphanGroups = bundle.opportunities
    .filter((item) => item.applicationGroupId && !groupIds.has(item.applicationGroupId))
    .map((item) => `${item.id}:${item.applicationGroupId}`)
  if (orphanGroups.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'orphan-application-group',
      message: '主表引用了不存在的申请组；共享志愿/名额约束可能失效。',
      count: orphanGroups.length,
      samples: orphanGroups.slice(0, 5),
    })
  }

  const invalidGroupActions = bundle.actions
    .filter((item) => item.kind === 'group_decision' && (!item.applicationGroupId || !groupIds.has(item.applicationGroupId)))
    .map((item) => item.id)
  if (invalidGroupActions.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'invalid-group-action',
      message: '存在无法关联到申请组的组级行动。',
      count: invalidGroupActions.length,
      samples: invalidGroupActions.slice(0, 5),
    })
  }

  const unlinkedProcesses = bundle.processes
    .filter((item) => !item.opportunityId || !opportunityIds.has(item.opportunityId))
    .map((item) => `${item.company}｜${item.role}`)
  if (unlinkedProcesses.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'unlinked-process',
      message: '部分在途流程无法可靠关联回主表岗位；流程仍可显示，但机会价值无法参与排序。',
      count: unlinkedProcesses.length,
      samples: unlinkedProcesses.slice(0, 5),
    })
  }

  const inconsistentGroups = bundle.applicationGroups
    .filter((group) => {
      if (group.total === undefined || group.used === undefined || group.remaining === undefined) return false
      return group.used + group.remaining !== group.total || group.used < 0 || group.remaining < 0
    })
    .map((group) => group.id)
  if (inconsistentGroups.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'inconsistent-group-capacity',
      message: '部分申请组的总名额、已用和剩余数量不一致。',
      count: inconsistentGroups.length,
      samples: inconsistentGroups.slice(0, 5),
    })
  }

  const constrainedGroups = new Set(
    bundle.actions
      .filter((item) => item.kind === 'group_decision' && item.applicationGroupId)
      .map((item) => item.applicationGroupId!),
  )
  if (constrainedGroups.size > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'constrained-application-groups',
      message: '已将共享志愿/有限名额冲突收敛为组级决策，而不是重复投递动作。',
      count: constrainedGroups.size,
      samples: [...constrainedGroups].slice(0, 5),
    })
  }

  return diagnostics
}

export function assertImportBundleSafe(bundle: ImportBundle) {
  const blocking = diagnoseImport(bundle).filter((item) => item.severity === 'error')
  if (blocking.length === 0) return
  throw new Error(blocking.map((item) => `${item.message} ${item.samples?.join('、') ?? ''}`.trim()).join('\n'))
}
