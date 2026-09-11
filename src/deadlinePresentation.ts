import type { ActionTimingMode, RankedAction } from './model.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type CountdownRisk = 'critical' | 'urgent' | 'soon' | 'normal'

export function priorityStepLabel(index: number) {
  const labels = ['第一要做', '第二要做', '第三要做', '第四要做', '第五要做', '第六要做']
  return labels[index] ?? `第 ${index + 1} 要做`
}

export function countdownMeta(
  dueAt: string,
  now = new Date(),
  timingMode: ActionTimingMode | undefined = 'deadline',
) {
  const remaining = new Date(dueAt).getTime() - now.getTime()
  const prefix = timingMode === 'fixed' ? '距开始' : '距截止'

  if (remaining <= 0) {
    return {
      label: timingMode === 'fixed' ? '已到开始时间' : '已到截止时间',
      risk: 'critical' as CountdownRisk,
      remainingMs: remaining,
    }
  }

  const totalMinutes = Math.max(1, Math.floor(remaining / MINUTE))
  let duration: string
  if (totalMinutes < 60) {
    duration = `${totalMinutes} 分钟`
  } else if (totalMinutes < 24 * 60) {
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    duration = `${hours} 小时${minutes ? ` ${minutes} 分` : ''}`
  } else {
    const days = Math.floor(totalMinutes / (24 * 60))
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
    duration = `${days} 天${hours ? ` ${hours} 小时` : ''}`
  }

  const risk: CountdownRisk = remaining <= 6 * HOUR
    ? 'critical'
    : remaining <= 24 * HOUR
      ? 'urgent'
      : remaining <= 72 * HOUR
        ? 'soon'
        : 'normal'

  return { label: `${prefix} ${duration}`, risk, remainingMs: remaining }
}

export function selectUpcomingDeadlineNodes(
  ranked: RankedAction[],
  now = new Date(),
  horizonDays = 7,
  limit = 6,
) {
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)
  const horizon = now.getTime() + Math.max(1, horizonDays) * DAY

  return ranked
    .filter((item) => item.action.dueAt && item.action.timingMode !== 'fixed')
    .filter((item) => {
      const due = new Date(item.action.dueAt!).getTime()
      return due > endOfToday.getTime() && due <= horizon
    })
    .sort((a, b) => new Date(a.action.dueAt!).getTime() - new Date(b.action.dueAt!).getTime())
    .slice(0, limit)
}
