import { parse, type DefaultTreeAdapterTypes } from 'parse5'

export type HtmlNode = DefaultTreeAdapterTypes.Node
export type HtmlElement = DefaultTreeAdapterTypes.Element
export function isElement(node: HtmlNode): node is HtmlElement { return 'tagName' in node }
export function childElements(node: HtmlNode): HtmlElement[] { return 'childNodes' in node ? node.childNodes.filter(isElement) : [] }
export function attribute(node: HtmlElement, name: string) { return node.attrs.find(value => value.name === name)?.value }
export function hasClass(node: HtmlElement, name: string) { return (attribute(node, 'class') ?? '').split(/\s+/).includes(name) }
function hidden(node: HtmlElement) {
  return ['script', 'style', 'noscript', 'template'].includes(node.tagName) || attribute(node, 'hidden') !== undefined
    || attribute(node, 'aria-hidden') === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attribute(node, 'style') ?? '')
}
export function parseSourceHtml(raw: string): DefaultTreeAdapterTypes.Document {
  if (new TextEncoder().encode(raw).byteLength > 1_000_000 || (raw.match(/</g)?.length ?? 0) > 20_000) throw new Error('Recruiting HTML exceeds its parser bound.')
  // Keep noscript payload inert, matching the normal scripting-enabled HTML
  // tree. Parsing the fallback mode can eject a head/noscript script into
  // the active tree before our inert-node exclusion can inspect it.
  return parse(raw, { scriptingEnabled: true })
}
export function descendants(root: HtmlNode, predicate: (node: HtmlElement) => boolean, skip?: (node: HtmlElement) => boolean): HtmlElement[] {
  const found: HtmlElement[] = [], stack: HtmlNode[] = [root]
  let visited = 0
  while (stack.length) {
    if (++visited > 30_000) throw new Error('Recruiting document exceeds the node bound.')
    const node = stack.pop()!
    if (isElement(node)) {
      if (hidden(node) || skip?.(node)) continue
      if (predicate(node)) found.push(node)
    }
    if ('childNodes' in node) stack.push(...[...node.childNodes].reverse())
  }
  return found
}
export function sourceText(root: HtmlNode, direct = false, skip?: (node: HtmlElement)=>boolean) {
  const pieces: string[] = [], stack: HtmlNode[] = [root]
  let visited = 0
  while (stack.length) {
    if (++visited > 30_000) throw new Error('Recruiting text exceeds the node bound.')
    const node = stack.pop()!
    if (node.nodeName === '#text' && 'value' in node) pieces.push(node.value)
    if (isElement(node) && (hidden(node)||skip?.(node))) continue
    if ('childNodes' in node) stack.push(...[...node.childNodes].reverse().filter(child => !direct || child.nodeName === '#text'))
  }
  return pieces.join(' ').replace(/\s+/g, ' ').trim()
}
export function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw new Error(`Expected exactly one ${label}.`)
  return values[0]!
}
export function directClass(root: HtmlNode, name: string): HtmlElement[] { return childElements(root).filter(node => hasClass(node, name)) }
export async function documentHash(raw: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(value => value.toString(16).padStart(2, '0')).join('')
}
