import type { PortfolioWarning } from './applicationPortfolio.js'

export function portfolioWarningText(warning: PortfolioWarning, zh: boolean) {
  switch (warning.code) {
    case 'capacity_fields_inconsistent':
      return zh
        ? `申请组名额字段不一致：总名额 ${warning.total} - 已用 ${warning.used} = ${warning.derived}，但“剩余”记录为 ${warning.remaining}；展示显式剩余值，请核对真实名额。`
        : `Application-group capacity fields disagree: total ${warning.total} - used ${warning.used} = ${warning.derived}, while remaining is ${warning.remaining}. The explicit remaining value is displayed; verify the actual quota.`
    case 'current_order_context':
      return zh
        ? '“当前排序/首选”是历史自由文本上下文，不作为隐藏硬约束；如需固定某个志愿，请先把申请组标记为锁定或更新结构化规则。'
        : 'Recorded preference/order is historical free-text context, not a hidden hard constraint. Lock the group or update its structured rule to make a preference binding.'
    case 'group_locked':
      return zh ? '申请组已锁定；TodayAction 不会给出替换志愿建议。' : 'The application group is locked; TodayAction will not propose replacement selections.'
    case 'capacity_unknown':
      return zh
        ? '剩余申请名额无法从结构化字段确定；TodayAction 只提供候选排序，不猜测可投数量。'
        : 'Remaining application capacity cannot be determined from structured fields. TodayAction lists candidates by deadline but does not guess how many applications are allowed.'
  }
}
