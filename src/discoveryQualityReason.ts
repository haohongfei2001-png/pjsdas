export const DISCOVERY_QUALITY_REASON_CODES = [
  'posting_closed',
  'deadline_expired',
  'role_type_not_allowed',
  'fit_below_minimum',
  'opportunity_value_below_minimum',
  'exclusion_match',
  'strict_location_missing',
  'strict_location_mismatch',
  'compensation_below_minimum',
  'existing_opportunity_source_duplicate',
  'recently_dismissed_inbox',
  'active_inbox_same_source',
  'active_inbox_cross_source',
  'recent_user_rejection',
  'existing_opportunity_duplicate',
  'batch_duplicate',
  'review_batch_limit',
] as const

export type DiscoveryQualityReasonCode = typeof DISCOVERY_QUALITY_REASON_CODES[number]
export type DiscoveryQualityReasonParam = string | number | boolean

export interface DiscoveryQualityReasonDetail {
  code: DiscoveryQualityReasonCode
  params?: Record<string, DiscoveryQualityReasonParam>
}

function stringParam(detail: DiscoveryQualityReasonDetail, key: string) {
  const value = detail.params?.[key]
  return value === undefined ? '' : String(value)
}

export function presentDiscoveryQualityReason(detail: DiscoveryQualityReasonDetail, zh: boolean) {
  const p = (key: string) => stringParam(detail, key)
  switch (detail.code) {
    case 'posting_closed':
      return zh ? '公开来源明确显示岗位已关闭。' : 'The public source explicitly shows that this job is closed.'
    case 'deadline_expired':
      return zh ? `岗位截止时间 ${p('deadline')} 已过去。` : `The job deadline ${p('deadline')} has passed.`
    case 'role_type_not_allowed':
      return zh ? `岗位类型 ${p('roleType')} 不在显式允许类型中。` : `Role type ${p('roleType')} is not in the explicitly allowed role types.`
    case 'fit_below_minimum':
      return zh ? `匹配度 ${p('score')} 低于显式门槛 ${p('minimum')}。` : `Fit score ${p('score')} is below the explicit minimum ${p('minimum')}.`
    case 'opportunity_value_below_minimum':
      return zh ? `机会价值 ${p('score')} 低于显式门槛 ${p('minimum')}。` : `Opportunity Value ${p('score')} is below the explicit minimum ${p('minimum')}.`
    case 'exclusion_match':
      return zh ? `来源证据命中明确排除条件“${p('rule')}”。` : `Source evidence matches the explicit exclusion “${p('rule')}”.`
    case 'strict_location_missing':
      return zh ? '地点为严格约束，但公开来源没有明确岗位地点。' : 'Location is a strict constraint, but the public source does not state a job location.'
    case 'strict_location_mismatch':
      return zh ? `岗位地点“${p('location')}”不符合严格地点约束。` : `Job location “${p('location')}” does not satisfy the strict location constraint.`
    case 'compensation_below_minimum':
      return zh
        ? `来源可验证最低年薪 ${p('actual')} 万元，低于显式门槛 ${p('minimum')} 万元。`
        : `The verified minimum annual compensation is ${p('actual')}×10k CNY, below the explicit ${p('minimum')}×10k CNY minimum.`
    case 'existing_opportunity_source_duplicate':
      return zh
        ? `TodayAction 已存在相同或高度相似岗位“${p('company')}｜${p('role')}”；公开来源 ${p('sourceHost')} 已归属于正式 Opportunity。`
        : `TodayAction already contains the same or a highly similar role “${p('company')} | ${p('role')}”; public source ${p('sourceHost')} already belongs to a formal Opportunity.`
    case 'recently_dismissed_inbox':
      return zh
        ? `发现箱中高度相似岗位“${p('company')}｜${p('role')}”最近已被明确拒绝。`
        : `A highly similar role “${p('company')} | ${p('role')}” in Discovery Inbox was explicitly rejected recently.`
    case 'active_inbox_same_source':
      return zh
        ? `同一招聘来源已经在发现箱（${p('status')}），最近验证于 ${p('lastVerifiedAt')}。`
        : `The same recruiting source is already in Discovery Inbox (${p('status')}); it was last verified at ${p('lastVerifiedAt')}.`
    case 'active_inbox_cross_source':
      return zh
        ? `高度相似岗位已经在发现箱（${p('status')}），且已有近期公开来源 ${p('sourceHost')}；本次跨来源结果不重复进入审阅。`
        : `A highly similar role is already in Discovery Inbox (${p('status')}) with recent public source ${p('sourceHost')}; this cross-source result is not added to review again.`
    case 'recent_user_rejection':
      return zh
        ? `用户在最近 120 天已明确拒绝高度相似岗位“${p('company')}｜${p('role')}”。`
        : `The user explicitly rejected a highly similar role “${p('company')} | ${p('role')}” within the last 120 days.`
    case 'existing_opportunity_duplicate':
      return zh
        ? `TodayAction 已存在相同或高度相似岗位“${p('company')}｜${p('role')}”。`
        : `TodayAction already contains the same or a highly similar role “${p('company')} | ${p('role')}”.`
    case 'batch_duplicate':
      return zh
        ? `本次候选中已存在高度相似岗位“${p('company')}｜${p('role')}”。`
        : `This discovery batch already contains a highly similar role “${p('company')} | ${p('role')}”.`
    case 'review_batch_limit':
      return zh
        ? `超过单批审阅上限 ${p('limit')}，按发现质量得分暂缓。`
        : `Deferred because the review batch exceeds the limit of ${p('limit')}; candidates are ordered by discovery quality score.`
  }
}
