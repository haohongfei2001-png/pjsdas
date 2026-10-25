import { factualDatePrecision, type DiscoveryFieldProof, type DiscoverySourceProof } from '../src/discoveryFactSchema.js'
import type { DiscoveryProfile } from '../src/discoveryProfile.js'
import { discoveryProfileManagementFingerprint } from '../src/discoveryProfileManagement.js'
import { buildDiscoveryScopeEvidence } from '../src/discoveryScopeEvidence.js'
import { verifiedDiscoveryObservationSchema } from '../src/verifiedDiscoveryCommand.js'
import { canonicalizeVerifiedJobSourceUrl } from '../src/jobPosting.js'
import { DISCOVERY_SOURCE_AUTHORITIES, type DiscoverySourceAuthority } from './discoverySourceAuthorities.js'
import { recruitingPublisherAuthority, sameRecruitingPublisherPosting } from './discoveryPublisher.js'
import { createDomesticDiscoveryAuthorityResolver } from './discoveryDomesticAuthority.js'
import { publicSourceLinks, sourceElementSelector as evidenceSelector } from './discoveryRecruitingLinks.js'
import type { MonitorJobObservation } from '../src/autonomousIngestion.js'
import { WorkspaceSourceError } from './workspaceSource.js'
import { assertPublicDiscoverySourceUrl, fetchPublicDiscoverySource, htmlTitle, normalizedEvidence, visibleSourceText } from './discoveryPublicSource.js'
import { parseSourceHtml, descendants, attribute, sourceText, isElement, childElements, type HtmlNode } from './discoveryHtml.js'
export { assertPublicDiscoverySourceUrl } from './discoveryPublicSource.js'

function sameText(left: string, right: string) {
  return normalizedEvidence(left) === normalizedEvidence(right)
}

function inBoundary(url: URL, origin: string, prefix: string) {
  const base = new URL(origin)
  const path = prefix.replace(/\/$/, '') || '/'
  return url.protocol === 'https:' && url.origin === base.origin
    && (path === '/' || url.pathname === path || url.pathname.startsWith(`${path}/`))
}

function authorityFor(url: URL, company: string, authorities: readonly DiscoverySourceAuthority[]) {
  const found = authorities.filter(entry => inBoundary(url, entry.sourceOrigin, entry.pathPrefix)
    && (entry.kind === 'university_recruiting' || entry.kind === 'recruiting_platform' || entry.companyNames?.some(name => sameText(name, company))))
  return found.length === 1 ? found[0] : undefined
}

function linkedRecruitingBoundary(raw: string, source: DiscoverySourceAuthority) {
  if (source.kind === 'ats' && (!source.pathPrefix || source.pathPrefix === '/')) return false
  return publicSourceLinks(raw, source.authorityPage, true).some(link => inBoundary(link.target, source.sourceOrigin, source.pathPrefix))
}

function jobPostingObjects(raw: string) {
  const objects: Record<string, unknown>[] = []
  let visited = 0
  function visit(value: unknown, depth = 0) {
    if (++visited > 2000 || depth > 12) throw new Error('Structured recruiting evidence exceeds its complete-document parsing bound.')
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return }
    if (!value || typeof value !== 'object') return
    const item = value as Record<string, unknown>
    const context = item['@context']
    if (context !== undefined && !['https://schema.org', 'http://schema.org', 'https://schema.org/', 'http://schema.org/'].includes(String(context))) {
      throw new Error('Unsupported or redefined structured-data context cannot establish recruiting semantics.')
    }
    if (item['@type'] === 'JobPosting' || Array.isArray(item['@type']) && item['@type'].includes('JobPosting')) objects.push(item)
    for (const [key, nested] of Object.entries(item)) {
      if (key !== '@context' && nested && typeof nested === 'object') visit(nested, depth + 1)
    }
  }
  if(!raw.trimStart().startsWith('{')&&!raw.trimStart().startsWith('[')){
    const stack:HtmlNode[]=[parseSourceHtml(raw)];let nodeCount=0
    while(stack.length){
      if(++nodeCount>30000)throw new Error('Structured recruiting HTML exceeds its parser bound.')
      const node=stack.pop()!
      if(isElement(node)){
        if(['template','noscript','style'].includes(node.tagName)||attribute(node,'hidden')!==undefined||attribute(node,'aria-hidden')==='true'
          ||/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attribute(node,'style')??''))continue
        if(node.tagName==='script'){
          if(node.namespaceURI==='http://www.w3.org/1999/xhtml'&&attribute(node,'type')?.toLowerCase()==='application/ld+json'){
            const content=node.childNodes.map(child=>'value' in child?child.value:'').join('')
            let value:unknown
            try{value=JSON.parse(content)}catch{throw new Error('Structured recruiting evidence contains malformed JSON.')}
            visit(value)
          }
          continue
        }
      }
      if('childNodes' in node)stack.push(...[...node.childNodes].reverse())
    }
  }
  if (raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) { visit(JSON.parse(raw)) }
  return objects
}

function text(value: unknown, max = 500) {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function exactDate(value: unknown) {
  const raw = text(value, 80)
  return raw && factualDatePrecision(raw) ? raw : undefined
}
function excludedPostingScopeNode(node: import('./discoveryHtml.js').HtmlElement) {
  return ['aside', 'nav', 'footer'].includes(node.tagName)
    || /(?:^|\s)(?:related|recommendations|similar-jobs)(?:\s|$)/i.test(attribute(node, 'class') ?? '')
}
/** Body qualification and scope matching are deliberately separate. Metadata
 * and controls cannot establish a loaded description, but their visible terms
 * must not disappear from exclusion matching when a real body is present. */
function postingBodyText(root: HtmlNode, company: string, role: string) {
  const heading = (node: import('./discoveryHtml.js').HtmlElement) => /^h[1-6]$/.test(node.tagName)
  const control = (node: import('./discoveryHtml.js').HtmlElement) => ['button', 'form', 'input', 'select', 'option', 'textarea', 'a'].includes(node.tagName)
    || attribute(node, 'role') === 'button'
  const elements = descendants(root, () => true)
  const identity = new Set(elements.filter(node => heading(node) || sameText(sourceText(node), company) || sameText(sourceText(node), role)))
  const metadataLabel = /^(?:公司名称|招聘单位|雇主|公司|employer|company|岗位名称|职位名称|job title|role|工作地点|地点|城市|location|申请截止(?:日期|时间)?|投递截止(?:日期|时间)?|application deadline|apply by|招聘批次|招聘届别|recruitment batch|发布日期|发布时间|date posted)\s*[:：]?$/i
  for (const list of elements.filter(node => node.tagName === 'dl')) {
    const children = childElements(list)
    for (let index = 0; index < children.length - 1; index += 1) {
      if (children[index]!.tagName === 'dt' && children[index + 1]!.tagName === 'dd' && metadataLabel.test(sourceText(children[index]!))) {
        identity.add(children[index]!); identity.add(children[index + 1]!)
      }
    }
  }
  return sourceText(root, false, node => control(node) || identity.has(node)
    || Boolean(attribute(node, 'itemprop') && !(attribute(node, 'itemprop') ?? '').split(/\s+/).includes('description')))
}

/** Never infer that an auxiliary/nested subtree belongs to a different job and
 * delete it to manufacture a complete negative proof. Visible ambiguity stays
 * incomplete; hidden/inert text is excluded by the shared bounded HTML parser.
 * This intentionally supports a bounded DOM contract, not arbitrary web pages. */
function postingScopeContent(root: HtmlNode, company: string, role: string) {
  const elements = descendants(root, () => true)
  const ambiguous = elements.some(node => attribute(node, 'aria-busy') === 'true'
    || ['status', 'progressbar'].includes(attribute(node, 'role') ?? '')
    || node !== root && (excludedPostingScopeNode(node) || node.tagName === 'article' || /\bJobPosting\b/.test(attribute(node, 'itemtype') ?? '')))
  const text = sourceText(root)
  return { text, body: postingBodyText(root, company, role), complete: !ambiguous && text.length <= 100000 }
}

/** Static DOM attribution only: this is not a rendered-browser visibility test. */
function visibleJobLabels(raw: string, company: string, role: string, url: URL, checkScope: boolean) {
  if (raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) return {}
  const document = parseSourceHtml(raw)
  const excluded = excludedPostingScopeNode
  const isHeading = (node: import('./discoveryHtml.js').HtmlElement) => /^h[1-6]$/.test(node.tagName) || attribute(node, 'itemprop') === 'title'
  const allHeadings = descendants(document, isHeading, excluded)
  if (allHeadings.some(node => /^(?:sign in to continue|log in to continue|登录后查看|请先登录|安全验证|人机验证|verify you are human)$/i.test(sourceText(node)))
    || /^(?:sign in|log in|登录|安全验证|captcha)(?:\s*[-|·]|$)/i.test(htmlTitle(raw) ?? '')) {
    throw new Error('The source presents an access challenge, not current accessible job evidence.')
  }
  const pointsElsewhere = (heading: import('./discoveryHtml.js').HtmlElement) => descendants(heading, node => node.tagName === 'a').some(anchor => {
      try { return canonicalizeVerifiedJobSourceUrl(new URL(attribute(anchor, 'href') ?? '', url).toString()) !== canonicalizeVerifiedJobSourceUrl(url.toString()) }
      catch { return false }
    })
  const headings = allHeadings.filter(node => sameText(sourceText(node), role) && !pointsElsewhere(node))
  const foreignScopes = new Set<import('./discoveryHtml.js').HtmlElement>()
  for (const heading of allHeadings) {
    if (!pointsElsewhere(heading)) continue
    let parent = heading.parentNode
    while (parent && isElement(parent) && !['body', 'html', 'main'].includes(parent.tagName) && attribute(parent, 'role') !== 'main') {
      if (headings.some(selected => descendants(parent!, node => node === selected).length)) break
      foreignScopes.add(parent)
      parent = parent.parentNode
    }
  }
  const scopes = new Set<import('./discoveryHtml.js').HtmlElement>()
  for (const heading of headings) {
    let parent = heading.parentNode
    let nearest: import('./discoveryHtml.js').HtmlElement | undefined
    while (parent && isElement(parent) && !['body', 'html'].includes(parent.tagName)) {
      const scope = parent
      const outside = (node: import('./discoveryHtml.js').HtmlElement) => excluded(node) || foreignScopes.has(node)
        || (node !== scope && (node.tagName === 'article' || /\bJobPosting\b/.test(attribute(node, 'itemtype') ?? '')))
      const matchesCompany = descendants(scope, node => sameText(sourceText(node), company), outside).length > 0
      if (matchesCompany) nearest = scope
      if (scope.tagName === 'article' || /\bJobPosting\b/.test(attribute(scope, 'itemtype') ?? '') || scope.tagName === 'main' || attribute(scope, 'role') === 'main') {
        if (!matchesCompany) throw new Error('Visible job company is outside this posting envelope.')
        nearest = scope
        break
      }
      parent = scope.parentNode
    }
    if (nearest) scopes.add(nearest)
  }
  if (scopes.size !== 1) throw new Error('One visible company/title posting envelope is required; layout alone cannot identify a job.')
  const scope = [...scopes][0]!
  const outside = (node: import('./discoveryHtml.js').HtmlElement) => excluded(node) || foreignScopes.has(node)
    || (node !== scope && (node.tagName === 'article' || /\bJobPosting\b/.test(attribute(node, 'itemtype') ?? '')))
  const pairs = descendants(scope, node => node.tagName === 'dl', outside).flatMap(list => {
    const children = childElements(list), result: Array<{ label: string; value: string; selector: string }> = []
    for (let index = 0; index < children.length - 1; index += 1) {
      if (children[index]!.tagName === 'dt' && children[index + 1]!.tagName === 'dd') result.push({
        label: sourceText(children[index]!).trim(), value: sourceText(children[index + 1]!).trim(), selector: evidenceSelector(children[index + 1]!),
      })
    }
    return result
  })
  const declaredEmployers = [
    ...descendants(scope, node => (attribute(node, 'itemprop') ?? '').split(/\s+/).includes('hiringOrganization'), outside).map(node => sourceText(node)),
    ...pairs.filter(pair => /^(?:公司名称|招聘单位|雇主|公司|employer|company)\s*[:：]?$/i.test(pair.label)).map(pair => pair.value),
  ]
  if (declaredEmployers.some(value => !sameText(value, company))) throw new Error('The current job explicitly names a different employer.')
  const single = (matches: typeof pairs) => ({ value: new Set(matches.map(pair => pair.value)).size === 1 ? matches[0]?.value : undefined,
    selector: matches[0]?.selector, conflict: new Set(matches.map(pair => pair.value)).size > 1 })
  const deadline = single(pairs.filter(pair => /^(?:申请截止(?:日期|时间)?|投递截止(?:日期|时间)?|application deadline|apply by)\s*[:：]?$/i.test(pair.label)))
  const batch = single(pairs.filter(pair => /^(?:招聘批次|招聘届别|recruitment batch)\s*[:：]?$/i.test(pair.label)))
  // This is the independently addressed posting envelope, not a search snippet,
  // page title, recommendation/sidebar, or another job's description. Keep the
  // complete bounded text in memory only; downstream evidence stores rule hits.
  const scopeContent = checkScope ? postingScopeContent(scope, company, role) : undefined
  const descriptionBody = checkScope && descendants(scope, node => (attribute(node, 'itemprop') ?? '').split(/\s+/).includes('description'))
    .some(node => Boolean(postingBodyText(node, company, role)))
  return { scopeContent, descriptionBody, deadline: exactDate(deadline.value), deadlineText: deadline.value, deadlineSelector: deadline.selector, batchSelector: batch.selector,
    deadlineConflict: deadline.conflict || (deadline.value !== undefined && !exactDate(deadline.value)),
    batchConflict: batch.conflict || (batch.value !== undefined && !text(batch.value, 160)), recruitmentBatch: text(batch.value, 160) }
}

function jobLocation(value: unknown) {
  const places = Array.isArray(value) ? value : value ? [value] : []
  if (places.length > 10) return undefined
  const locations = places.map(place => {
    const address = object(object(place)?.address)
    if (!address) return undefined
    const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
      .map(part => text(part, 80) ?? text(object(part)?.name, 80)).filter(Boolean)
    return [...new Set(parts)].join(', ')
  }).filter(Boolean)
  return text([...new Set(locations)].join('; '), 240)
}

interface ExtractedPosting {
  unresolvedFields?: Array<'deadline'|'recruitmentBatch'>
  company: string
  role: string
  nativeId?: string
  location?: string
  recruitmentBatch?: string
  deadline?: string
  publishedAt?: string
  description?: string
  scopeText?: string
  scopeTextComplete?: boolean
  selectors: Record<string, string>
}

function extractStructuredPosting(raw: string, url: URL, observation: MonitorJobObservation, authority: DiscoverySourceAuthority, checkScope: boolean): ExtractedPosting {
  const jobs = jobPostingObjects(raw)
  const addressed = jobs.length === 1 ? jobs : jobs.filter(job => {
    try { return typeof job.url === 'string' && canonicalizeVerifiedJobSourceUrl(job.url) === canonicalizeVerifiedJobSourceUrl(url.toString()) } catch { return false }
  })
  if (addressed.length !== 1) throw new Error('A single independently addressed JobPosting is required; a listing is not a job detail.')
  const job = addressed[0]!
  const company = text(object(job.hiringOrganization)?.name, 200), role = text(job.title, 240)
  if (!company || !role || !sameText(company, observation.company) || !sameText(role, observation.role)) throw new Error('Structured company and original job title do not match the candidate.')
  if ((authority.kind === 'employer' || authority.kind === 'ats') && !authority.companyNames?.some(name => sameText(name, company))) throw new Error('Employer identity is outside the reviewed binding.')
  const identifier = object(job.identifier)
  const documentId = text(identifier?.value, 200) ?? text(job.identifier, 200)
  const ownUrl = text(job.url, 2000)
  const expectedId = authority.documentPostId
  const matchesExpectedId = documentId && expectedId && (documentId === expectedId
    || authority.id === 'recruiting-platform:beisen' && documentId.toLocaleLowerCase() === expectedId)
  const exactAddress = ownUrl ? canonicalizeVerifiedJobSourceUrl(ownUrl) === canonicalizeVerifiedJobSourceUrl(url.toString())
    : authority.kind === 'recruiting_platform' ? Boolean(matchesExpectedId)
      : Boolean(documentId && (decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '').replace(/\.(?:s?html?)$/i, '') === documentId
        || [...url.searchParams].some(([key, value]) => /^(?:id|job_?id|position_?id|jid)$/i.test(key) && value === documentId)))
  if (!exactAddress) throw new Error('The selected JobPosting is not addressed by the requested detail URL or native ID.')
  // Only after the document independently proves its URL/record identity may
  // the known platform supply the composite tenant/site identity used to dedup.
  const nativeId = authority.nativePostId
  const visible=visibleJobLabels(raw, company, role, url, checkScope)
  // These extension names have no universal JobPosting meaning. A deadline
  // needs reviewed source semantics or an explicit label inside this job's
  // visible detail; a candidate value or unrelated page date never supplies it.
  const deadlineField = authority.applicationDeadlineField
  const structuredDeadline=deadlineField?exactDate(job[deadlineField]):undefined
  const deadlineConflict=visible.deadlineConflict||Boolean(structuredDeadline&&visible.deadlineText!==undefined&&structuredDeadline!==visible.deadline)
  const description = text(job.description, 100000)
  const descriptionContent = checkScope && description ? postingScopeContent(parseSourceHtml(description), company, role) : undefined
  const complete = (job.description === undefined || typeof job.description === 'string' && job.description.length <= 100000)
    && (descriptionContent === undefined || descriptionContent.complete)
    && (visible.scopeContent === undefined || visible.scopeContent.complete)
    && Boolean(descriptionContent?.body || visible.descriptionBody)
  return { company, role, nativeId, location: jobLocation(job.jobLocation),
    unresolvedFields:[...(deadlineConflict?['deadline' as const]:[]),...(visible.batchConflict?['recruitmentBatch' as const]:[])],
    recruitmentBatch: visible.recruitmentBatch, deadline: deadlineConflict?undefined:structuredDeadline??visible.deadline, publishedAt: exactDate(job.datePosted),
    description,
    scopeText: complete ? [descriptionContent?.text, visible.scopeContent?.text].filter(Boolean).join('\n') : undefined,
    scopeTextComplete: complete,
    selectors: { company: 'JobPosting.hiringOrganization.name', role: 'JobPosting.title', location: 'JobPosting.jobLocation',
      recruitmentBatch: visible.batchSelector ?? 'unresolved', deadline: structuredDeadline ? `JobPosting.${deadlineField}` : visible.deadlineSelector ?? 'unresolved', publishedAt: 'JobPosting.datePosted' } }
}

async function extractGreenhousePosting(url: URL, observation: MonitorJobObservation, authority: DiscoverySourceAuthority, fetchImpl: typeof fetch, checkScope: boolean) {
  if (!authority.tenant || !/^[a-z0-9_-]{1,100}$/i.test(authority.tenant)) throw new Error('Reviewed Greenhouse tenant is missing.')
  const id = url.pathname.match(/\/jobs\/(\d+)\/?$/)?.[1]
  if (!id) throw new Error('A public Greenhouse job-post ID is required.')
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(authority.tenant)}/jobs/${id}`
  const fetched = await fetchPublicDiscoverySource(apiUrl, fetchImpl, candidate => candidate.origin === 'https://boards-api.greenhouse.io' && candidate.pathname === new URL(apiUrl).pathname)
  const job = object(JSON.parse(fetched.raw))
  const role = text(job?.title, 240)
  if (String(job?.id) !== id || !role || !sameText(role, observation.role)) throw new Error('The public post ID/title did not match the single-post ATS response.')
  if (typeof job?.absolute_url !== 'string' || !inBoundary(new URL(job.absolute_url), authority.sourceOrigin, authority.pathPrefix)
    || new URL(job.absolute_url).pathname.match(/\/jobs\/(\d+)\/?$/)?.[1] !== id) throw new Error('The ATS response does not link to this employer tenant and public post.')
  const company = authority.companyNames?.find(name => sameText(name, observation.company))
  if (!company) throw new Error('The employer identity has no reviewed tenant binding.')
  const description = text(job?.content, 100000)
  const scopeContent = checkScope && description ? postingScopeContent(parseSourceHtml(description), company, role) : undefined
  const posting: ExtractedPosting = { company, role, nativeId: id, location: text(object(job?.location)?.name, 240),
    deadline: exactDate(job?.application_deadline), publishedAt: exactDate(job?.first_published), description,
    scopeText: scopeContent?.text, scopeTextComplete: Boolean(scopeContent?.complete && scopeContent.body),
    selectors: { company: `reviewed-binding:${authority.id}`, role: '$.title', location: '$.location.name', deadline: '$.application_deadline', publishedAt: '$.first_published' } }
  return { fetched, posting, identity: `greenhouse:${authority.tenant}:post:${id}` }
}

export interface DiscoverySourceVerifierOptions {
  fetchImpl?: typeof fetch
  now?: Date
  authorities?: readonly DiscoverySourceAuthority[]
  resolveAuthority?: (url: URL) => Promise<DiscoverySourceAuthority | undefined>
  /** Trusted current snapshot only, never model/candidate-supplied criteria. */
  profile?: DiscoveryProfile
}

/** Share only public publisher evidence within one caller's bounded batch. */
export function createDiscoverySourceVerifier(options: DiscoverySourceVerifierOptions = {}) {
  const now = options.now ?? new Date()
  const profile = options.profile ? structuredClone(options.profile) : undefined
  const resolveAuthority = options.resolveAuthority ?? createDomesticDiscoveryAuthorityResolver({ fetchImpl: options.fetchImpl, now: () => now })
  return (observation: MonitorJobObservation) => verifyDiscoverySourceObservation(observation, { ...options, profile, now, resolveAuthority })
}

/** Input claims never survive as trusted fields merely because the URL responds. */
export async function verifyDiscoverySourceObservation(
  observation: MonitorJobObservation,
  options: DiscoverySourceVerifierOptions = {},
): Promise<MonitorJobObservation> {
  const fetchImpl = options.fetchImpl ?? fetch
  const verifiedAt = (options.now ?? new Date()).toISOString()
  const profile = options.profile ? structuredClone(options.profile) : undefined
  const checkScope = Boolean(profile && (profile.mustHave.length || profile.mustNotHave.length))
  const unresolved = (reason: string): MonitorJobObservation => ({
    sourceRecordId: observation.sourceRecordId, company: observation.company, role: observation.role,
    sourceUrl: observation.sourceUrl, sourceTitle: observation.sourceTitle,
    discoveredAt: verifiedAt, sourceVerification: 'unverified', sourceVerificationReason: reason.slice(0, 500),
  })
  try {
    const requested = assertPublicDiscoverySourceUrl(observation.sourceUrl)
    const authority = authorityFor(requested, observation.company, options.authorities ?? DISCOVERY_SOURCE_AUTHORITIES)
      ?? (options.authorities ? undefined : recruitingPublisherAuthority(requested) ?? await (options.resolveAuthority
        ?? createDomesticDiscoveryAuthorityResolver({ fetchImpl, now: () => new Date(verifiedAt) }))(requested))
    if (!authority) return unresolved('DISCOVERY_SOURCE_AUTHORITY_REQUIRED: no reviewed employer/institution recruiting-source binding')
    if (!inBoundary(new URL(authority.authorityPage), authority.authorityOrigin, '/')) throw new Error('Invalid reviewed authority page.')
    if (authority.evidence && (!Number.isFinite(Date.parse(authority.evidence.expiresAt)) || !Number.isFinite(Date.parse(authority.evidence.fetchedAt))
      || Date.parse(authority.evidence.fetchedAt) > Date.parse(verifiedAt) || Date.parse(authority.evidence.expiresAt) <= Date.parse(verifiedAt))) return unresolved('DISCOVERY_SOURCE_AUTHORITY_EXPIRED: refresh the publisher relationship before using it')
    const relationship = authority.kind === 'recruiting_platform'
      ? { url: new URL(authority.authorityPage), raw: '' }
      : await fetchPublicDiscoverySource(authority.authorityPage, fetchImpl, url => inBoundary(url, authority.authorityOrigin, '/'))
    if (new URL(authority.sourceOrigin).origin !== new URL(authority.authorityOrigin).origin && !linkedRecruitingBoundary(relationship.raw, authority)) {
      return unresolved('DISCOVERY_SOURCE_AUTHORITY_REQUIRED: the trusted employer/institution page does not link to this reviewed recruiting boundary')
    }
    let fetched: { url: URL; raw: string }, posting: ExtractedPosting, postingIdentity: string
    if (authority.adapter === 'greenhouse') {
      const extracted = await extractGreenhousePosting(requested, observation, authority, fetchImpl, checkScope)
      fetched = extracted.fetched; posting = extracted.posting; postingIdentity = extracted.identity
    } else {
      fetched = await fetchPublicDiscoverySource(requested.toString(), fetchImpl, url => inBoundary(url, authority.sourceOrigin, authority.pathPrefix)
        && sameRecruitingPublisherPosting(authority, url)
        && (authority.kind === 'recruiting_platform' || canonicalizeVerifiedJobSourceUrl(url.toString()) === canonicalizeVerifiedJobSourceUrl(requested.toString())))
      posting = extractStructuredPosting(fetched.raw, fetched.url, observation, authority, checkScope)
      postingIdentity = JSON.stringify([authority.id, posting.nativeId ?? canonicalizeVerifiedJobSourceUrl(fetched.url.toString())])
    }
    const documentSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fetched.raw)))].map(value => value.toString(16).padStart(2, '0')).join('')
    const fields: DiscoveryFieldProof[] = []
    for (const field of ['company', 'role', 'location', 'recruitmentBatch', 'deadline', 'publishedAt'] as const) {
      const value = posting[field]
      if (value) fields.push({ field, value, sourceUrl: fetched.url.toString(), selector: posting.selectors[field]!, quote: value.slice(0, 500), documentSha256, verifiedAt })
    }
    const sourceProof: DiscoverySourceProof = { version: 1, authority: authority.kind, authorityUrl: relationship.url.toString(),
      requestedUrl: requested.toString(), finalUrl: fetched.url.toString(), verifiedAt, documentSha256, postingIdentity,
      sourceNativeId: posting.nativeId, fields, unresolvedFields:posting.unresolvedFields?.length?posting.unresolvedFields:undefined, authorityEvidence: authority.evidence }
    const scopeEvidence = profile && (profile.mustHave.length || profile.mustNotHave.length)
      ? buildDiscoveryScopeEvidence({ profile, scopeFingerprint: await discoveryProfileManagementFingerprint(profile), documentSha256,
        text: [posting.company, posting.role, posting.location, posting.recruitmentBatch, posting.scopeText].filter(Boolean).join('\n'),
        complete: Boolean(posting.scopeTextComplete) }) : undefined
    // Status is conservative: a reachable page or application button is not an
    // independent guarantee that applications remain open.
    const verified = { sourceRecordId: postingIdentity, company: posting.company, role: posting.role,
      sourceUrl: authority.adapter === 'greenhouse' ? requested.toString() : fetched.url.toString(),
      sourceTitle: (htmlTitle(fetched.raw) ?? posting.role).slice(0, 300), location: posting.location, recruitmentBatch: posting.recruitmentBatch,
      deadline: posting.deadline, deadlinePrecision: posting.deadline ? factualDatePrecision(posting.deadline) : undefined,
      publishedAt: posting.publishedAt, publishedPrecision: posting.publishedAt ? factualDatePrecision(posting.publishedAt) : undefined,
      sourceEvidenceText: visibleSourceText(posting.description ?? '').slice(0, 2000) || undefined,
      scopeEvidence,
      postingStatus: 'unknown', discoveredAt: verifiedAt, sourceVerification: 'verified', sourceVerifiedAt: verifiedAt, sourceProof }
    const validated = verifiedDiscoveryObservationSchema.safeParse(verified)
    if (!validated.success) return unresolved('DISCOVERY_SOURCE_INVALID: independently fetched evidence exceeds the supported factual contract')
    return validated.data
  } catch (caught) {
    return unresolved(caught instanceof WorkspaceSourceError ? `${caught.code}: ${caught.message}`
      : `DISCOVERY_SOURCE_UNVERIFIED: ${caught instanceof Error ? caught.message : 'source verification failed'}`)
  }
}
