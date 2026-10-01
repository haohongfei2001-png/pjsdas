import type { TodayBriefAction } from '../todayBrief.js'

/** Hide only a complete repeated application identity; preserve all other context. */
export function hasRepeatedApplicationContext(item: Pick<TodayBriefAction, 'kind' | 'title' | 'company' | 'role' | 'opportunityId'>): boolean {
  if (item.kind !== 'apply' || !item.opportunityId || !item.company?.trim() || !item.role?.trim()) return false
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const title = normalize(item.title)
  const company = normalize(item.company), role = normalize(item.role)
  return ['|', '·'].some(separator => title === `投递 ${company}${separator}${role}`
    || title === `投递 ${company} ${separator} ${role}`)
}
