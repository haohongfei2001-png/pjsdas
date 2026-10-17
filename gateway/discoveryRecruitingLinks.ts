import { attribute, childElements, descendants, isElement, parseSourceHtml, sourceText, type HtmlElement, type HtmlNode } from './discoveryHtml.js'
import { assertPublicDiscoverySourceUrl } from './discoveryPublicSource.js'

export function sourceElementSelector(node: HtmlElement) {
  const parts: string[] = []
  let current: HtmlNode | null = node
  while (current && isElement(current) && !['body', 'html'].includes(current.tagName)) {
    const element: HtmlElement = current
    const siblings = element.parentNode ? childElements(element.parentNode).filter(sibling => sibling.tagName === element.tagName) : [element]
    parts.unshift(`${element.tagName}:nth-of-type(${siblings.indexOf(element) + 1})`)
    current = element.parentNode
  }
  const selector = parts.join(' > ')
  if (selector.length > 300) throw new Error('The source reference exceeds its evidence selector bound.')
  return selector
}

/** Literal visible links only. Advertisements, friends sections, hidden links
 * and scripts cannot establish a publisher relationship. No targets are fetched. */
export function publicSourceLinks(raw: string, pageUrl: string, recruitingOnly = false) {
  const document = parseSourceHtml(raw)
  // The first base[href] also affects links when that element is hidden.
  // Traverse the parsed document, excluding inert template content naturally.
  const stack: HtmlNode[] = [document]
  let baseUrl = pageUrl
  while (stack.length) {
    const node = stack.pop()!
    if (isElement(node) && node.namespaceURI === 'http://www.w3.org/1999/xhtml' && node.tagName === 'base' && attribute(node, 'href') !== undefined) {
      baseUrl = assertPublicDiscoverySourceUrl(new URL(attribute(node, 'href')!, pageUrl).toString()).toString()
      break
    }
    if ('childNodes' in node) stack.push(...[...node.childNodes].reverse())
  }
  const anchors = descendants(document, node => node.namespaceURI === 'http://www.w3.org/1999/xhtml' && node.tagName === 'a')
  let ancestorVisits = 0
  return anchors.flatMap(anchor => {
    const quote = sourceText(anchor), href = attribute(anchor, 'href')
    if (!href || href.length > 2000 || !quote || quote.length > 500) return []
    if (recruitingOnly && !/招聘|招募|加入我们|加入团队|工作机会|人才|就业|\bcareers?\b|\bjobs?\b|join\s+us|work\s+with\s+us/i.test(quote)) return []
    let parent: HtmlNode | null = anchor
    while (parent) {
      if (++ancestorVisits > 30000) throw new Error('Recruiting link ancestry exceeds its complete-document bound.')
      if (isElement(parent)) {
        if (['body', 'html'].includes(parent.tagName)) break
        const heading = childElements(parent).filter(node => /^h[1-6]$/.test(node.tagName) || attribute(node, 'role') === 'heading'
          || /(?:^|\s)(?:title|heading)(?:\s|$)/i.test(attribute(node, 'class') ?? '')).map(node => sourceText(node)).join(' ')
        if (/友情链接|合作伙伴|友链|广告|\bfriends?\b|\bpartners?\b|related.links|advertis|(?:^|\s)ads?(?:\s|$)/i.test(`${attribute(parent, 'id') ?? ''} ${attribute(parent, 'class') ?? ''} ${heading}`)
          || (attribute(parent, 'rel') ?? '').split(/\s+/).some(value => ['sponsored', 'ugc'].includes(value.toLowerCase()))) return []
      }
      parent = 'parentNode' in parent ? parent.parentNode : null
    }
    let target: URL
    try {
      target = assertPublicDiscoverySourceUrl(new URL(href, baseUrl).toString())
      if (target.protocol === 'http:') target.protocol = 'https:'
    } catch { return [] }
    // Exhausted evidence bounds invalidate the complete relationship set.
    // Silently dropping a deep narrow link could authorize a broader one.
    return [{ href, target, quote, selector: sourceElementSelector(anchor) }]
  })
}
