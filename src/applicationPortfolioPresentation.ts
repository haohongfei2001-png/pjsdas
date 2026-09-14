import type { PortfolioCandidateReason, PortfolioWarning } from './applicationPortfolio.js'

export function portfolioReasonText(reason: PortfolioCandidateReason, zh: boolean) {
  switch (reason.code) {
    case 'high_opportunity_value': return zh ? '机会价值高' : 'High opportunity value'
    case 'high_fit': return zh ? '匹配度较高' : 'Strong fit'
    case 'core_role': return zh ? '核心机会' : 'Core opportunity'
    case 'low_application_cost': return zh ? '投递成本较低' : 'Low application cost'
    case 'near_deadline': return zh ? '截止窗口较近' : 'Deadline is approaching'
    case 'low_evidence_confidence': return zh ? '评估证据置信度偏低' : 'Low assessment evidence confidence'
    case 'high_overlap': return zh
      ? `与已推荐岗位高度重叠（相似度 ${reason.similarityPercent}%）`
      : `High overlap with a recommended role (${reason.similarityPercent}% similar)`
    case 'capacity_marginal': return zh ? '名额有限，组合边际价值低于已推荐岗位' : 'Limited capacity; marginal portfolio value is below recommended roles'
    case 'no_marginal_value': return zh ? '加入后没有提高当前组合的净边际价值' : 'Adding this role does not improve net portfolio value'
  }
}

export function portfolioWarningText(warning: PortfolioWarning, zh: boolean) {
  switch (warning.code) {
    case 'capacity_fields_inconsistent':
      return zh
        ? `申请组名额字段不一致：总名额 ${warning.total} - 已用 ${warning.used} = ${warning.derived}，但“剩余”记录为 ${warning.remaining}；组合决策优先采用显式剩余值。`
        : `Application-group capacity fields disagree: total ${warning.total} - used ${warning.used} = ${warning.derived}, while remaining is ${warning.remaining}. Portfolio decisions use the explicit remaining value.`
    case 'current_order_context':
      return zh
        ? '“当前排序/首选”是历史自由文本上下文，不作为隐藏硬约束；如需固定某个志愿，请先把申请组标记为锁定或更新结构化规则。'
        : 'Recorded preference/order is historical free-text context, not a hidden hard constraint. Lock the group or update its structured rule to make a preference binding.'
    case 'group_locked':
      return zh ? '申请组已锁定；PJSDAS 不会给出替换志愿建议。' : 'The application group is locked; PJSDAS will not propose replacement selections.'
    case 'capacity_unknown':
      return zh
        ? '剩余申请名额无法从结构化字段确定；PJSDAS 只提供候选排序，不猜测可投数量。'
        : 'Remaining application capacity cannot be determined from structured fields. PJSDAS ranks candidates but does not guess how many applications are allowed.'
    case 'optimization_capped':
      return zh
        ? `候选超过 ${warning.cap} 个；组合优化只对基础分最高的 ${warning.cap} 个执行，其他候选保留在未推荐列表。`
        : `${warning.candidateCount} eligible candidates exceed the ${warning.cap}-candidate optimization cap. PJSDAS optimizes the top ${warning.cap} by base score and keeps the rest in the not-recommended list.`
  }
}
