import type { DiscoverySourceAuthority } from './discoverySourceAuthorities.js'

/** Publisher recognition is verification context, never a search-domain filter.
 * Other public candidates still enter the ledger and can use an independently
 * evidenced employer/institution resolver; unsupported sources stay explicit. */
const recruitingPublishers = [
  { id: 'boss-zhipin', hosts: ['www.zhipin.com', 'zhipin.com'], detail: /^\/job_detail\/([A-Za-z0-9_-]+)\.html$/ },
  { id: 'zhilian', hosts: ['www.zhaopin.com', 'jobs.zhaopin.com'], detail: /^\/(?:jobdetail\/)?(CCL?[0-9]+J[0-9]+)\.html?$/ },
  { id: '51job', hosts: ['jobs.51job.com'], detail: /^\/[^/]+\/([0-9]+)\.html$/ },
  { id: 'liepin', hosts: ['www.liepin.com', 'liepin.com'], detail: /^\/job\/([0-9]+)\.shtml$/ },
] as const

function platformAuthority(id: string, url: URL, nativePostId: string, documentPostId = nativePostId): DiscoverySourceAuthority {
  return { id: `recruiting-platform:${id}`, kind: 'recruiting_platform', sourceOrigin: url.origin,
    pathPrefix: url.pathname.replace(/\/$/, '') || '/', authorityOrigin: url.origin, authorityPage: url.origin,
    adapter: 'job_posting_jsonld', nativePostId, documentPostId }
}

/** A recognized address only selects the verifier. It never proves a job or
 * the legal identity of an employer; every accepted fact still needs the exact
 * current recruiting record. Unsupported ATS formats remain unresolved.
 * Moka route semantics: https://www.mokahr.com/docs/api/
 * Beisen supplier link: https://www.beisen.com/ → beisen.zhiye.com
 */
export function recruitingPublisherAuthority(url: URL): DiscoverySourceAuthority | undefined {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined
  const publisher = recruitingPublishers.find(entry => entry.hosts.some(host => url.hostname === host) && entry.detail.test(url.pathname))
  if (publisher) return platformAuthority(publisher.id, url, publisher.detail.exec(url.pathname)![1]!)
  if (url.hostname === 'app.mokahr.com') {
    // This documented desktop route keeps org/site/mode separate from the job
    // in the fragment. List and application subroutes are not job reads.
    const route = /^\/(apply|campus_apply)\/([A-Za-z0-9_-]{1,100})(?:\/([A-Za-z0-9_-]{1,100}))?\/?$/.exec(url.pathname)
    const job = /^#\/job\/([A-Za-z0-9_-]{1,120})\/?$/.exec(url.hash)
    if (!route || !job) return undefined
    return platformAuthority('moka', url, JSON.stringify([route[1], route[2], route[3] ?? null, job[1]]), job[1])
  }
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.zhiye\.com$/.test(url.hostname)
    && !['www', 'api', 'portal-oss'].includes(url.hostname.split('.')[0]!) && url.pathname === '/social/detail' && !url.hash) {
    const ids = url.searchParams.getAll('jobAdId')
    if (ids.length !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(ids[0]!)) return undefined
    return platformAuthority('beisen', url, JSON.stringify([url.hostname, 'social', ids[0]!.toLowerCase()]), ids[0]!.toLowerCase())
  }
  return undefined
}

export function sameRecruitingPublisherPosting(authority: DiscoverySourceAuthority, candidate: URL) {
  if (authority.kind !== 'recruiting_platform' || !authority.nativePostId) return true
  const current = recruitingPublisherAuthority(candidate)
  return current?.id === authority.id && current.nativePostId === authority.nativePostId && current.sourceOrigin === authority.sourceOrigin
}
