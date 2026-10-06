import { compareDeadlines } from './deadlineOrder.js'
import { jobPostingForInboxItem, jobPostingFreshness } from './jobPosting.js'
import type { DiscoveryInboxItem } from './model.js'

export interface DiscoveryDecisionSignal {
  key: string
  zh: string
  en: string
}

export interface DiscoveryDecisionSummary {
  knownFacts: number
  totalFacts: number
  completenessPercent: number
  strengths: DiscoveryDecisionSignal[]
  risks: DiscoveryDecisionSignal[]
  missing: DiscoveryDecisionSignal[]
}

const DAY_MS = 24 * 60 * 60 * 1000

function signal(key: string, zh: string, en: string): DiscoveryDecisionSignal {
  return { key, zh, en }
}

export function discoveryDecisionSummary(item: DiscoveryInboxItem, now = new Date()): DiscoveryDecisionSummary {
  const missing: DiscoveryDecisionSignal[] = []
  if (!item.location?.trim()) missing.push(signal('location', '地点未明确', 'Location not stated'))
  if (!item.deadline?.trim()) missing.push(signal('deadline', '截止时间未明确', 'Deadline not stated'))
  if (!item.compensationText?.trim()) missing.push(signal('compensation', '薪资未明确', 'Compensation not stated'))

  const totalFacts = 3
  const knownFacts = totalFacts - missing.length
  const completenessPercent = Math.round((knownFacts / totalFacts) * 100)

  const strengths: DiscoveryDecisionSignal[] = []
  if (!item.profileWarnings?.length) strengths.push(signal('no-profile-warning', '暂无偏好或证据警告', 'No profile or evidence warnings'))

  const posting = jobPostingForInboxItem(item)
  const freshness = jobPostingFreshness(posting, now)
  if (freshness === 'fresh' && posting.postingStatus === 'open') {
    strengths.push(signal('source-fresh-open', '公开来源近期验证为开放', 'Public source was recently verified open'))
  }

  const risks: DiscoveryDecisionSignal[] = []
  if (item.profileWarnings?.length) {
    risks.push(signal('profile-warnings', `存在 ${item.profileWarnings.length} 条偏好或证据警告`, `${item.profileWarnings.length} profile or evidence warning(s)`))
  }
  if (posting.postingStatus === 'unknown') risks.push(signal('posting-status-unknown', '来源未明确确认岗位仍开放', 'Source does not explicitly confirm the posting is open'))
  if (freshness === 'aging') risks.push(signal('source-aging', '来源验证已超过 7 天', 'Source verification is more than 7 days old'))
  if (freshness === 'stale') risks.push(signal('source-stale', '来源验证已超过 21 天，建议重新确认', 'Source verification is over 21 days old; re-check recommended'))
  if (freshness === 'closed') risks.push(signal('source-closed', '来源状态或截止时间显示岗位已关闭', 'Source status or deadline indicates the posting is closed'))
  if (posting.supersededByPostingId) risks.push(signal('source-superseded', '该来源已被更新的招聘发布替代', 'This source has been superseded by a newer posting'))
  if (item.postingHistory?.length) risks.push(signal('source-history', `已记录 ${item.postingHistory.length + 1} 个来源版本`, `${item.postingHistory.length + 1} source versions recorded`))

  if (item.deadline) {
    const deadline = new Date(item.deadline).getTime()
    if (!Number.isNaN(deadline)) {
      const remaining = deadline - now.getTime()
      if (remaining < 0) risks.push(signal('deadline-passed', '公开截止时间已经过去', 'Public deadline has passed'))
      else if (remaining <= 3 * DAY_MS) risks.push(signal('deadline-soon', '距离截止不足 72 小时', 'Deadline is within 72 hours'))
    }
  }

  return {
    knownFacts,
    totalFacts,
    completenessPercent,
    strengths,
    risks,
    missing,
  }
}

export function sortDiscoveryInboxItems(items: DiscoveryInboxItem[]) {
  return [...items].sort((a, b) => compareDeadlines(a, b))
}
