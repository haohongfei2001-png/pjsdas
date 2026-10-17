import type { DiscoverySourceAuthority } from './discoverySourceAuthorities.js'
import type { DiscoveryAuthorityEvidence } from '../src/discoveryFactSchema.js'
import { childElements, descendants, documentHash, hasClass, one, parseSourceHtml, sourceText } from './discoveryHtml.js'
import { assertPublicDiscoverySourceUrl, fetchPublicDiscoverySource } from './discoveryPublicSource.js'
import { publicSourceLinks, sourceElementSelector } from './discoveryRecruitingLinks.js'

export const MOE_UNIVERSITY_DIRECTORY = 'https://hudong.moe.gov.cn/jyb_zzjg/moe_347/'
const AUTHORITY_TTL_MS = 60 * 60_000
type Fetched = { url: URL; raw: string; fetchedAt: number }
type Link = ReturnType<typeof publicSourceLinks>[number]
const uniqueLinks = (links: Link[]) => [...new Map(links.map(link => [link.target.toString(), link])).values()]
// A suffix is only a directory lookup hint. Both the official row and literal
// careers link must be independently fetched. Other TLDs remain unresolved.
function institutionDomain(host: string) { return /(?:^|\.)([a-z0-9-]+\.edu\.cn)$/.exec(host)?.[1] }
function contains(candidate: URL, link: URL) {
  const prefix = link.pathname.replace(/\/$/, '') || '/'
  return candidate.origin === link.origin && !link.search && !link.hash
    && (prefix === '/' || candidate.pathname === prefix || candidate.pathname.startsWith(`${prefix}/`))
}
async function evidenceLink(page: Fetched, link: Link): Promise<DiscoveryAuthorityEvidence['links'][number]> {
  return { sourceUrl: page.url.toString(), href: link.href, targetUrl: link.target.toString(), selector: link.selector,
    quote: link.quote, documentSha256: await documentHash(page.raw) }
}

/** Request-scoped, expiring proof for matching institutions in the current
 * official directory. Search stays unrestricted; this establishes a recruiting
 * publisher relationship, never employer identity or individual job facts. */
export function createDomesticDiscoveryAuthorityResolver(options: { fetchImpl?: typeof fetch; now?: () => Date } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch, clock = options.now ?? (() => new Date())
  const cache = new Map<string, { expiresAt: number; pending: Promise<DiscoverySourceAuthority | undefined> }>()
  const pages = new Map<string, { expiresAt: number; pending: Promise<Fetched> }>()
  async function page(raw: string, allowed: (url: URL) => boolean): Promise<Fetched> {
    const cached = pages.get(raw)
    if (cached && cached.expiresAt > clock().getTime()) {
      const value = await cached.pending
      if (!allowed(value.url)) throw new Error('Cached publisher page is outside the exact link boundary.')
      return value
    }
    if (pages.size >= 100) pages.delete(pages.keys().next().value!)
    const fetchedAt = clock().getTime(), pending = fetchPublicDiscoverySource(raw, fetchImpl, allowed).then(value => ({ ...value, fetchedAt }))
    pages.set(raw, { expiresAt: fetchedAt + AUTHORITY_TTL_MS, pending })
    try { return await pending } catch (error) { if (pages.get(raw)?.pending === pending) pages.delete(raw); throw error }
  }
  let directoryCache: { expiresAt: number; pending: Promise<Fetched> } | undefined
  async function directory() {
    if (!directoryCache || directoryCache.expiresAt <= clock().getTime()) {
      const pending = page(MOE_UNIVERSITY_DIRECTORY, url => url.toString() === MOE_UNIVERSITY_DIRECTORY)
      directoryCache = { expiresAt: clock().getTime() + AUTHORITY_TTL_MS, pending }
      pending.catch(() => { if (directoryCache?.pending === pending) directoryCache = undefined })
    }
    return directoryCache.pending
  }
  async function resolveCurrent(candidate: URL, domain: string): Promise<DiscoverySourceAuthority | undefined> {
    const official = await directory()
    // Current official markup, read from the directory on 2026-10-07:
    // .moe-detail-box > h1 + dl.moe-schools > dd > a.outMoeLink.
    // Footer/news links and a title elsewhere on the page are not directory rows.
    const document = parseSourceHtml(official.raw)
    const box = one(descendants(document, node => hasClass(node, 'moe-detail-box')
      && childElements(node).some(child => child.tagName === 'h1' && sourceText(child) === '教育部直属高等学校')), 'official directory container')
    const list = one(childElements(box).filter(node => node.tagName === 'dl' && hasClass(node, 'moe-schools')), 'official directory list')
    const rowSelectors = new Set(childElements(list).filter(node => node.tagName === 'dd').flatMap(row =>
      childElements(row).filter(node => node.tagName === 'a' && hasClass(node, 'outMoeLink')).map(sourceElementSelector)))
    const matchingRows = publicSourceLinks(official.raw, official.url.toString()).filter(link => rowSelectors.has(link.selector) && /大学|学院/.test(link.quote)
      && link.quote.length <= 100 && institutionDomain(link.target.hostname) === domain && !link.target.search && !link.target.hash)
    const rows = [...new Map(matchingRows.map(link => [JSON.stringify([link.target.toString(), link.quote]), link])).values()]
    if (rows.length !== 1) return undefined
    const entry = rows[0]!, root = entry.target
    const homepage = await page(root.toString(), url => url.origin === root.origin)
    const homeLinks = uniqueLinks(publicSourceLinks(homepage.raw, homepage.url.toString(), true))
    let ownerPage = homepage, path: Link[] = [], finalLinks = homeLinks.filter(link => contains(candidate, link.target)
      && (link.target.origin !== root.origin || link.target.pathname !== '/'))
    if (!finalLinks.length) {
      // One same-origin navigation layer, at most three links, with no recursive
      // crawl. This includes official admissions/employment landing pages.
      const navigation = homeLinks.filter(link => link.target.origin === root.origin && !link.target.search && !link.target.hash
        && link.target.pathname !== homepage.url.pathname)
      if (navigation.length > 3) return undefined
      for (const navigationLink of navigation) {
        const navigationPage = await page(navigationLink.target.toString(), url => url.origin === root.origin)
        const matches = uniqueLinks(publicSourceLinks(navigationPage.raw, navigationPage.url.toString(), true)).filter(link => contains(candidate, link.target))
        if (!matches.length) continue
        if (finalLinks.length && matches.some(link => !finalLinks.some(old => old.target.toString() === link.target.toString()))) return undefined
        if (!finalLinks.length) { ownerPage = navigationPage; path = [navigationLink]; finalLinks = matches }
      }
    }
    if (finalLinks.length !== 1) return undefined
    const careers = finalLinks[0]!, target = careers.target
    if (institutionDomain(target.hostname) !== domain || [root, homepage.url, ownerPage.url].some(ancestor => contains(ancestor, target))) return undefined
    const links = [await evidenceLink(official, entry)]
    if (path[0]) links.push(await evidenceLink(homepage, path[0]))
    links.push(await evidenceLink(ownerPage, careers))
    const at = new Date(Math.min(official.fetchedAt, homepage.fetchedAt, ownerPage.fetchedAt)).toISOString()
    return { id: `cn-moe:${domain}:${target.origin}${target.pathname}`, kind: 'university_recruiting',
      sourceOrigin: target.origin, pathPrefix: target.pathname.replace(/\/$/, '') || '/', authorityOrigin: root.origin,
      authorityPage: ownerPage.url.toString(), adapter: 'job_posting_jsonld',
      evidence: { version: 1, publisherId: 'cn-moe-affiliated-universities', institution: entry.quote, rootUrl: homepage.url.toString(),
        fetchedAt: at, expiresAt: new Date(Date.parse(at) + AUTHORITY_TTL_MS).toISOString(), links } }
  }
  return async function resolve(sourceUrl: URL): Promise<DiscoverySourceAuthority | undefined> {
    const candidate = assertPublicDiscoverySourceUrl(sourceUrl.toString()), domain = institutionDomain(candidate.hostname)
    if (candidate.protocol !== 'https:' || !domain) return undefined
    const key = candidate.origin + candidate.pathname
    const existing = cache.get(key)
    if (existing && existing.expiresAt > clock().getTime()) return structuredClone(await existing.pending)
    if (cache.size >= 100) cache.delete(cache.keys().next().value!)
    const pending = resolveCurrent(candidate, domain)
    cache.set(key, { expiresAt: clock().getTime() + AUTHORITY_TTL_MS, pending })
    try {
      const result = await pending
      if (result) {
        if (cache.get(key)?.pending === pending) cache.get(key)!.expiresAt = Date.parse(result.evidence!.expiresAt)
      } else if (cache.get(key)?.pending === pending) cache.delete(key)
      return structuredClone(result)
    } catch (error) { if (cache.get(key)?.pending === pending) cache.delete(key); throw error }
  }
}
