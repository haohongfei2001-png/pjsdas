// New post-recovery HTML security regressions. No browser or live publisher calls.
import { describe, expect, it } from 'vitest'
import { attribute, childElements, descendants, documentHash, hasClass, one, parseSourceHtml, sourceText } from '../gateway/discoveryHtml.js'
import { publicSourceLinks, sourceElementSelector } from '../gateway/discoveryRecruitingLinks.js'

const page = 'https://www.example.edu.cn/admissions/index.html'
const literal = '<a href="https://careers.example.edu.cn/jobs/">就业信息</a>'

describe('rebuilt visible recruiting-link extraction', () => {
  it('extracts decoded literal anchors with attributable selectors and exact targets', () => {
    const links = publicSourceLinks('<main><h1>招生就业</h1><a href="../jobs/?kind=graduate&amp;year=2027">就业 &amp; Careers</a></main>', page, true)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ href: '../jobs/?kind=graduate&year=2027', quote: '就业 & Careers', selector: 'main:nth-of-type(1) > a:nth-of-type(1)' })
    expect(links[0]!.target.href).toBe('https://www.example.edu.cn/jobs/?kind=graduate&year=2027')
  })
  it.each([
    ['hidden attribute', `<section hidden>${literal}</section>`], ['aria-hidden', `<section aria-hidden="true">${literal}</section>`],
    ['display none', `<section style="display : none">${literal}</section>`], ['visibility hidden', `<section style="visibility:hidden">${literal}</section>`],
    ['template', `<template>${literal}</template>`], ['script', `<script>const html = '${literal}';</script>`],
    ['style', `<style>${literal}</style>`], ['body noscript', `<body><noscript>${literal}</noscript></body>`],
    ['HTML comment', `<!--${literal}-->`],
    ['SVG anchor', '<svg><a href="https://careers.example.edu.cn/jobs/"><text>就业信息</text></a></svg>'],
    ['MathML anchor', '<math><a href="https://careers.example.edu.cn/jobs/">就业信息</a></math>'],
  ])('rejects inactive or foreign-namespace link: %s', (_label, raw) => {
    expect(publicSourceLinks(raw, page, true)).toEqual([])
  })
  it('does not promote head/noscript text to a recruiting link through parser recovery', () => {
    expect(publicSourceLinks(`<html><head><noscript>${literal}</noscript></head><body>School</body></html>`, page, true)).toEqual([])
  })
  it.each([
    ['ad class', `<div class="ads">${literal}</div>`], ['advertising ID', `<div id="advertisement">${literal}</div>`],
    ['friends heading', `<section><h2>友情链接</h2>${literal}</section>`], ['partner heading role', `<section><div role="heading">合作伙伴</div>${literal}</section>`],
    ['friends title class', `<section><span class="title">友情链接</span>${literal}</section>`],
    ['sponsored anchor', '<a rel="sponsored" href="https://careers.example.edu.cn/jobs/">招聘</a>'],
    ['UGC ancestor', `<section rel="UGC"><div>${literal}</div></section>`],
    ['nested navigation under friends', `<section id="friends"><nav><ul><li>${literal}</li></ul></nav></section>`],
    ['navigation ancestor heading', `<nav><h2>合作伙伴</h2><div><ul><li>${literal}</li></ul></div></nav>`],
  ])('rejects commercial or unrelated ancestor context: %s', (_label, raw) => {
    expect(publicSourceLinks(raw, page, true)).toEqual([])
  })
  it('accepts ordinary recruiting navigation while excluding unrelated generic links', () => {
    const raw = `<nav><h2>学生服务</h2>${literal}<a href="/research">科研成果</a></nav>`
    expect(publicSourceLinks(raw, page, true)).toHaveLength(1)
    expect(publicSourceLinks(raw, page)).toHaveLength(2)
  })
  it.each(['javascript:alert(1)', 'jav&#x61;script:alert(1)', 'data:text/plain,careers', 'file:///etc/passwd',
    'http://127.0.0.1/jobs', 'https://[::ffff:127.0.0.1]/', 'https://jobs.local/careers', 'https://user:secret@careers.example.edu.cn/'])('rejects unsafe decoded href %s', href => {
    expect(publicSourceLinks(`<a href="${href}">就业信息</a>`, page, true)).toEqual([])
  })
  it('uses the first HTML base URL, even if hidden, and leaves absolute links independent', () => {
    const links = publicSourceLinks('<head><base hidden href="https://other.example.edu.cn/careers/"><base href="https://ignored.example.edu.cn/"></head><body><a href="job/42">招聘</a><a href="https://careers.example.edu.cn/jobs/">就业</a></body>', page, true)
    expect(links.map(link => link.target.href)).toEqual(['https://other.example.edu.cn/careers/job/42', 'https://careers.example.edu.cn/jobs/'])
  })
  it('ignores inert template base and foreign-namespace base elements', () => {
    const raw = '<template><base href="https://inert.example.edu.cn/"></template><svg><base href="https://foreign.example.edu.cn/"></base></svg><math><base href="https://math.example.edu.cn/"></base></math><a href="jobs">就业</a>'
    expect(publicSourceLinks(raw, page, true).map(link => link.target.href)).toEqual(['https://www.example.edu.cn/admissions/jobs'])
  })
  it('fails the complete relationship set for an unsafe effective base', () => {
    expect(() => publicSourceLinks(`<head><base href="http://127.0.0.1/private/"></head><body>${literal}</body>`, page, true)).toThrow()
  })
  it('upgrades an explicitly public HTTP institution link to HTTPS', () => {
    expect(publicSourceLinks('<a href="http://careers.example.edu.cn/">就业</a>', page, true)[0]!.target.href).toBe('https://careers.example.edu.cn/')
  })
  it('does not infer a target from script onclick, data attributes or anchor text', () => {
    expect(publicSourceLinks('<a onclick="location.href=\'https://careers.example.edu.cn/\'" data-href="https://careers.example.edu.cn/">就业 https://careers.example.edu.cn/</a>', page, true)).toEqual([])
  })
})

describe('rebuilt parser and complete-document evidence bounds', () => {
  it('preserves tree ownership and excludes hidden descendants from source text', () => {
    const document = parseSourceHtml('<main class="root careers"><article><h1>招聘 &amp; 就业</h1><p>Visible <span hidden>hidden</span><strong>bold</strong></p><script>spoof</script></article></main>')
    const main = one(descendants(document, node => node.tagName === 'main'), 'main')
    expect(hasClass(main, 'careers')).toBe(true)
    expect(attribute(main, 'class')).toBe('root careers')
    expect(childElements(main).map(node => node.tagName)).toEqual(['article'])
    expect(sourceText(main)).toBe('招聘 & 就业 Visible bold')
    const paragraph = one(descendants(main, node => node.tagName === 'p'), 'paragraph')
    expect(sourceText(paragraph, true)).toBe('Visible')
    expect(sourceElementSelector(paragraph)).toBe('main:nth-of-type(1) > article:nth-of-type(1) > p:nth-of-type(1)')
  })
  it('allows a caller to exclude whole unrelated subtrees', () => {
    const document = parseSourceHtml('<main><h1>Current</h1><aside><h1>Other job</h1></aside><article>Target</article></main>')
    const excluded = (node: { tagName: string }) => node.tagName === 'aside'
    expect(descendants(document, node => node.tagName === 'h1', excluded).map(node => sourceText(node))).toEqual(['Current'])
    expect(sourceText(document, false, excluded)).toBe('Current Target')
  })
  it('requires exactly one structural match', () => {
    expect(one(['only'], 'entry')).toBe('only')
    expect(() => one([], 'entry')).toThrow('exactly one')
    expect(() => one(['a', 'b'], 'entry')).toThrow('exactly one')
  })
  it('bounds input by UTF-8 bytes and complete markup count', () => {
    expect(() => parseSourceHtml('a'.repeat(1_000_000))).not.toThrow()
    expect(() => parseSourceHtml('界'.repeat(333334))).toThrow('parser bound')
    expect(() => parseSourceHtml('<'.repeat(20_001))).toThrow('parser bound')
  })
  it('bounds traversal independently of the raw HTML input size', () => {
    const document = parseSourceHtml('<br>a'.repeat(16_000))
    expect(() => descendants(document, () => false)).toThrow('node bound')
    expect(() => sourceText(document)).toThrow('node bound')
  })
  it('invalidates the complete link set instead of silently skipping overlong evidence selectors', () => {
    const raw = `${literal}${'<section>'.repeat(30)}${literal}${'</section>'.repeat(30)}`
    expect(() => publicSourceLinks(raw, page, true)).toThrow('selector bound')
  })
  it('bounds aggregate ancestor work across thousands of individually valid anchors', () => {
    const raw = `${'<div>'.repeat(8)}${literal.repeat(3600)}${'</div>'.repeat(8)}`
    expect(() => publicSourceLinks(raw, page, true)).toThrow('ancestry')
  })
  it('hashes exact document bytes, including whitespace, rather than normalized claims', async () => {
    expect(await documentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(await documentHash('abc ')).not.toBe(await documentHash('abc'))
  })
})
