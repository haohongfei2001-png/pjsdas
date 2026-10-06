import { hashMutationPayload } from './mutationKernel.js'

/** Immutable application capabilities. No OAuth scope or existing v2 grant is upgraded. */
export const SCOPED_MANAGEMENT_CONSENTS = Object.freeze({
  business: Object.freeze({
    version: 7 as const, capability: 'workspace.business.manage' as const,
    title: '独立准备、手动行动与投递组',
    scope: Object.freeze(['读取当前账号中明确选择的准备任务、行动和投递组', '创建、修改、可恢复归档独立准备任务、独立手动行动和投递组', '撤销上述修改；后续目标或依赖发生变化时拒绝覆盖']),
    exclusions: Object.freeze(['不修改由招聘事实、准备任务或日程派生的行动', '不永久删除、不修改账号安全或其他授权、不发送外部消息或投递', '现有基础管理授权不会自动转为此项授权']),
    duration: '持续有效，直到你撤销；撤销不回滚已经完成的修改。',
  }),
  opportunity: Object.freeze({
    version: 3 as const, capability: 'workspace.opportunity.manage' as const,
    title: '机会资料与可恢复归档',
    scope: Object.freeze(['读取及修改明确支持的机会资料字段', '可恢复归档指定机会及其专属关联记录', '撤销上述修改，后续依赖或冲突存在时拒绝覆盖']),
    exclusions: Object.freeze(['不编造来源事实、招聘日期或投递状态', '不删除共享记录、不永久删除、不触发外部提醒或投递']),
    duration: '持续有效，直到你撤销；撤销不回滚已经完成的修改。',
  }),
  planning: Object.freeze({
    version: 4 as const, capability: 'workspace.planning.manage' as const,
    title: '时间偏好',
    scope: Object.freeze(['读取、修改、重置时间偏好', '撤销上述修改，后续冲突存在时拒绝覆盖']),
    exclusions: Object.freeze(['历史评分与策略已退役，不改写历史数据', '不修改已有招聘事实或重新安排已有日程']),
    duration: '持续有效，直到你撤销；撤销不回滚已经完成的修改。',
  }),
  discoveryProfile: Object.freeze({
    version: 5 as const, capability: 'workspace.discovery-profile.manage' as const,
    title: '职位发现偏好',
    scope: Object.freeze(['读取、修改、重置职位发现偏好及自由文本备注', '这些偏好与优势备注可能影响未来检索及检索服务接收的上下文', '撤销上述修改，后续冲突存在时拒绝覆盖']),
    exclusions: Object.freeze(['不授权付费检索或增加预算', '不启用自动检索或新的外部服务', '不重写来源事实或历史检索记录']),
    duration: '持续有效，直到你撤销；撤销不回滚已经完成的修改。',
  }),
  privateReminder: Object.freeze({
    version: 6 as const, capability: 'workspace.reminders.manage' as const,
    title: '应用内私人提醒',
    scope: Object.freeze(['读取、创建、修改、暂停、取消应用内私人提醒', '撤销上述修改，后续日程变化或冲突存在时拒绝覆盖']),
    exclusions: Object.freeze(['不发送消息，不创建外部任务或日历事项', '不修改外部提醒、发送队列或招聘日程事实', '不授权持续对外通信']),
    duration: '持续有效，直到你撤销；撤销不回滚已经完成的修改。',
  }),
})
export type ScopedManagementDomain = keyof typeof SCOPED_MANAGEMENT_CONSENTS
export const scopedManagementDomains = Object.freeze(Object.keys(SCOPED_MANAGEMENT_CONSENTS) as ScopedManagementDomain[])
export function scopedManagementConsentHash(domain: ScopedManagementDomain) {
  const descriptor = SCOPED_MANAGEMENT_CONSENTS[domain]
  return hashMutationPayload(`scoped_management_consent_v${descriptor.version}`, descriptor)
}
