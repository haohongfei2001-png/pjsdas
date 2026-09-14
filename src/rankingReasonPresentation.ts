const exactEnglishReasons: Record<string, string> = {
  '固定流程已过，立即确认': 'Fixed event has passed — confirm now',
  '今天固定时间': 'Fixed time today',
  '近期固定时间': 'Fixed event soon',
  '流程节点已过，立即确认': 'Recruiting step has passed — confirm now',
  '流程节点今天到期': 'Recruiting step due today',
  '今天硬截止': 'Hard deadline today',
  '节点非常近': 'Immediate timing risk',
  '近期节点': 'Upcoming milestone',
  '真实流程通知': 'Recruiter-confirmed process event',
  '共享志愿/名额约束': 'Shared application quota',
  '核心机会': 'Core opportunity',
  '早投有收益': 'Early-application advantage',
  '现实成功率较高': 'Strong fit',
  '流程已到复核节点': 'Follow-up due',
  '可复用于多个岗位': 'Reusable across roles',
  '完成成本低': 'Low effort',
  '计划执行日': 'Planned execution date',
  '准备任务': 'Prep task',
}

export function presentRankingReason(reason: string, zh: boolean) {
  if (zh) return reason
  const exact = exactEnglishReasons[reason]
  if (exact) return exact

  const processWindow = reason.match(/^流程节点(\d+)小时内$/)
  if (processWindow) return `Recruiting step within ${processWindow[1]} hours`

  const deadlineWindow = reason.match(/^(\d+)小时内硬截止$/)
  if (deadlineWindow) return `Hard deadline within ${deadlineWindow[1]} hours`

  const graphCoverage = reason.match(/^覆盖(\d+)岗 · (\d+)个需求$/)
  if (graphCoverage) return `Covers ${graphCoverage[1]} roles · ${graphCoverage[2]} needs`

  return reason
}

export function presentRankingReasons(reasons: string[], zh: boolean) {
  return reasons.map((reason) => presentRankingReason(reason, zh))
}
