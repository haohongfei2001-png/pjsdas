import { discoverySearchScope, type DiscoveryProfile } from './discoveryProfile.js'

export type DiscoveryQueryCoverage = 'general_web' | 'recruiting_platforms' | 'employer_sites' | 'university_publishers'
export interface DiscoveryWebQuery {
  query: string
  coverage: DiscoveryQueryCoverage
  /** Supplemental targeting only. General-web requests remain unrestricted. */
  domains?: string[]
}
const PLATFORM_SUPPLEMENTS = ['zhipin.com', 'zhaopin.com', '51job.com', 'liepin.com', 'nowcoder.com', 'shixiseng.com', 'lagou.com', 'yingjiesheng.com']

/** Search reach and source verification are independent. This plan does not
 * decide which employers may exist or which returned domains may be verified. */
export function buildDiscoveryWebQueries(profile?: DiscoveryProfile) {
  const scope = discoverySearchScope(profile)
  const terms = scope.targetRoleQueries.length ? scope.targetRoleQueries : scope.searchGoal ? [scope.searchGoal] : []
  const queries: DiscoveryWebQuery[] = []
  const locations = scope.preferredLocations.length ? scope.preferredLocations.slice(0, 4) : ['']
  const locationQueries = scope.locationPolicy === 'strict' ? locations : [...new Set(['', ...locations])]
  const targets = locationQueries.flatMap(location => terms.slice(0, 6).map(raw => ({ raw, location })))
  for (const { raw, location } of targets.slice(0, 12)) {
    const term = raw.trim().replace(/\s+/g, ' ')
    if (!term) continue
    // Locations are factual constraints supplied by the user. No graduation
    // year, employer tier, compensation or role rating is inferred here.
    const base = [term, location].filter(Boolean).join(' ')
    queries.push(
      { query: `${base} 招聘`, coverage: 'general_web' },
      { query: `${base} 招聘 官网 careers`, coverage: 'employer_sites' },
      { query: `${base} 招聘 高校 就业`, coverage: 'university_publishers' },
      { query: `${base} 招聘`, coverage: 'recruiting_platforms', domains: [...PLATFORM_SUPPLEMENTS] },
    )
  }
  const unique = [...new Map(queries.map(item => [JSON.stringify(item), item])).values()]
  return { queries: unique, termCount: terms.length, plannedTermCount: Math.min(terms.length, 6),
    omittedTermCount: Math.max(0, terms.length - 6),
    omittedLocationCount: Math.max(0, scope.preferredLocations.length - 4),
    omittedTargetCount: Math.max(0, targets.length - 12),
    limitations: ['Search-engine indexing and source access can omit jobs. Platform targeting supplements unrestricted web search; it is not a closed website list.'] }
}
