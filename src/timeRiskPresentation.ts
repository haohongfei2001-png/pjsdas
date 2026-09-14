import type { TimeRiskLevel } from './timeRisk.js'
import { remainingTimeMs } from './timeRisk.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function presentTimeRemaining(dueAt: string, now: Date, zh: boolean) {
  const remaining = remainingTimeMs(dueAt, now)
  if (remaining <= 0) return zh ? '已到节点' : 'Reached'

  const minutes = Math.max(1, Math.ceil(remaining / MINUTE))
  if (minutes < 60) return zh ? `剩 ${minutes} 分钟` : `${minutes} min left`

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) {
    if (zh) return restMinutes > 0 ? `剩 ${hours} 小时 ${restMinutes} 分钟` : `剩 ${hours} 小时`
    return restMinutes > 0 ? `${hours} hr ${restMinutes} min left` : `${hours} hr left`
  }

  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  if (days < 7) {
    if (zh) return restHours > 0 ? `剩 ${days} 天 ${restHours} 小时` : `剩 ${days} 天`
    return restHours > 0 ? `${days} d ${restHours} hr left` : `${days} d left`
  }

  const roundedDays = Math.ceil(remaining / DAY)
  return zh ? `剩 ${roundedDays} 天` : `${roundedDays} d left`
}

export function presentTimeRiskLevel(level: TimeRiskLevel, zh: boolean) {
  const labels: Record<TimeRiskLevel, [string, string]> = {
    critical: ['极高风险', 'Critical'],
    high: ['高风险', 'High risk'],
    near: ['临近', 'Near'],
    watch: ['需准备', 'Prepare'],
    upcoming: ['已排期', 'Scheduled'],
  }
  return labels[level][zh ? 0 : 1]
}
