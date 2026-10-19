import type { SemanticCandidate, ScheduleNodeTemporal } from '../model.js'

/** Show every model-proposed business fact before confirmation, without deriving
 * an end-of-day time, changing timezone, or implying a deadline is an appointment. */
export function aiCandidateDetails(candidate: SemanticCandidate, zh: boolean, timezone?: string): string[] {
  const result: string[] = []
  const add = (label: string, value: string | number | undefined) => { if (value !== undefined && value !== '') result.push(`${label}: ${value}`) }
  const precision = (value?: string) => value === 'date' ? (zh ? '仅日期，不含具体时刻' : 'date only, no time') : value === 'datetime' ? (zh ? '具体时刻' : 'exact time') : undefined
  const temporal = (value: ScheduleNodeTemporal) => {
    const labels = { fixed_range: zh ? '固定安排' : 'Fixed appointment', availability_window: zh ? '可用时间段' : 'Availability window',
      deadline: zh ? '完成截止' : 'Completion deadline', date_only: zh ? '仅日期' : 'Date only', estimated_date: zh ? '预计日期' : 'Estimated date' }
    add(zh ? '时间类型' : 'Timing', labels[value.shape]); add(zh ? '时区' : 'Timezone', value.timezone)
    add(zh ? '开始' : 'Start', value.startAt); add(zh ? '结束' : 'End', value.endAt)
    add(zh ? '最晚开始' : 'Latest start', value.latestStartAt); add(zh ? '截止' : 'Deadline', value.deadlineAt)
    add(zh ? '日期' : 'Date', value.date); add(zh ? '精度' : 'Precision', precision(value.precision))
  }
  if ('plannedDate' in candidate && candidate.plannedDate) {
    add(zh ? '计划日期（不含具体时刻）' : 'Planned date (no time)', candidate.plannedDate)
    add(zh ? '时区' : 'Timezone', timezone)
  }
  if ('scheduledTemporal' in candidate && candidate.scheduledTemporal) temporal(candidate.scheduledTemporal)
  if ('temporal' in candidate && candidate.temporal) temporal(candidate.temporal)
  if ('timingMode' in candidate && candidate.timingMode) add(zh ? '安排含义' : 'Timing meaning', candidate.timingMode === 'fixed' ? (zh ? '固定预约' : 'Fixed appointment') : (zh ? '完成截止' : 'Completion deadline'))
  if ('occurredAt' in candidate) add(zh ? '发生于' : 'Occurred at', candidate.occurredAt)
  if ('notes' in candidate) add(zh ? '备注' : 'Notes', candidate.notes)
  if ('deadline' in candidate) {
    add(zh ? '截止' : 'Deadline', candidate.deadline)
    add(zh ? '截止精度' : 'Deadline precision', precision('deadlinePrecision' in candidate ? candidate.deadlinePrecision : 'precision' in candidate ? candidate.precision : undefined))
  }
  if (candidate.kind === 'user_opportunity') {
    add(zh ? '地点' : 'Location', candidate.location); add(zh ? '薪酬' : 'Compensation', candidate.compensationText)
    add(zh ? '来源标题' : 'Source title', candidate.sourceTitle); add(zh ? '来源网址' : 'Source URL', candidate.sourceUrl)
  }
  return result
}
