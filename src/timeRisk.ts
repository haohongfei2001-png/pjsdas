import type { Action, RankedAction } from './model'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type TimeRiskLevel = 'critical' | 'high' | 'near' | 'watch' | 'upcoming'

export interface TimeRisk {
  level: TimeRiskLevel
  label: string
  remainingMs: number
}

export function remainingTimeMs(dueAt: string, now = new Date()) {
  return new Date(dueAt).getTime() - now.getTime()
}

export function formatTimeRemaining(dueAt: string, now = new Date()) {
  const remaining = remainingTimeMs(dueAt, now)
  if (remaining <= 0) return '已到节点'

  const minutes = Math.max(1, Math.ceil(remaining / MINUTE))
  if (minutes < 60) return `剩 ${minutes} 分钟`

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) {
    return restMinutes > 0 ? `剩 ${hours} 小时 ${restMinutes} 分钟` : `剩 ${hours} 小时`
  }

  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  if (days < 7) return restHours > 0 ? `剩 ${days} 天 ${restHours} 小时` : `剩 ${days} 天`
  return `剩 ${Math.ceil(remaining / DAY)} 天`
}

export function timeRisk(dueAt: string, now = new Date()): TimeRisk {
  const remainingMs = remainingTimeMs(dueAt, now)
  if (remainingMs <= 6 * HOUR) return { level: 'critical', label: '极高风险', remainingMs }
  if (remainingMs <= 24 * HOUR) return { level: 'high', label: '高风险', remainingMs }
  if (remainingMs <= 48 * HOUR) return { level: 'near', label: '临近', remainingMs }
  if (remainingMs <= 72 * HOUR) return { level: 'watch', label: '需准备', remainingMs }
  return { level: 'upcoming', label: '已排期', remainingMs }
}

export function actionNodePrefix(action: Action) {
  if (action.timingMode === 'fixed') return '距开始'
  if (action.sourceLabel === '计划执行日') return '距计划'
  if (action.kind === 'apply' || action.kind === 'group_decision' || action.processEventId) return '距失效'
  return '距节点'
}

export function upcomingNodes(
  ranked: RankedAction[],
  now = new Date(),
  horizonDays = 7,
  limit = 8,
) {
  const horizon = now.getTime() + horizonDays * DAY
  return ranked
    .filter((item) => {
      const action = item.action
      if (!action.dueAt || action.kind === 'prep' || action.kind === 'follow_up') return false
      const due = new Date(action.dueAt).getTime()
      return due > now.getTime() && due <= horizon
    })
    .sort((a, b) => new Date(a.action.dueAt!).getTime() - new Date(b.action.dueAt!).getTime())
    .slice(0, limit)
}
