import { describe, expect, it } from 'vitest'
import { proposeSearchScope } from '../src/searchScopeDraft.js'
import { mergeDiscoveryScope, discoveryScopeSchema } from '../src/discoveryScopeSchema.js'
import { createDefaultDiscoveryProfile, discoverySearchScope } from '../src/discoveryProfile.js'
import { evaluateDiscoveryCandidate } from '../src/discoveryQuality.js'
import { discoveryProfileSavePayload } from '../src/discoveryProfileSave.js'
const at = '2026-10-17T02:00:00.000Z'
describe('B3 explicit search scope proposals', () => {
  it('prepares, broadens and excludes visibly without mutating saved scope', () => {
    const first = proposeSearchScope('产品经理')
    const broad = proposeSearchScope('更广一些', first)
    const excluded = proposeSearchScope('不要运营', broad)
    expect(first.targetRoleQueries).toEqual(['产品经理'])
    expect(broad.targetRoleQueries).toEqual(['产品经理', 'AI 产品经理', 'AI 应用产品经理'])
    expect(excluded.titleExcludes).toEqual(['运营'])
    expect(excluded.targetRoleQueries).toEqual(broad.targetRoleQueries)
  })
  it('confirms exact original titles end to end, preserving legacy unrelated facts', () => {
    const raw = { ...createDefaultDiscoveryProfile(at), notes: 'Historical notes', strengths: ['Legacy'] }
    const draft = proposeSearchScope('只要纯产品经理', proposeSearchScope('产品经理'))
    const saved = mergeDiscoveryScope(raw, discoveryScopeSchema.parse(draft), at)
    expect(saved.notes).toBe(raw.notes)
    expect(discoveryProfileSavePayload(saved).titleEquals).toEqual(['产品经理'])
    expect(discoverySearchScope(saved).titleEquals).toEqual(['产品经理'])
    const candidate = { company: 'A', role: '产品经理', sourceUrl: 'https://example.com/job', sourceTitle: 'Job', sourceEvidenceText: '岗位：产品经理', postingStatus: 'open' as const }
    expect(evaluateDiscoveryCandidate(saved, candidate, undefined, new Date(at)).accepted).toBe(true)
    for (const role of ['AI 产品经理', '产品运营', '高级产品经理', '产品经理（实习）']) expect(evaluateDiscoveryCandidate(saved, { ...candidate, role }, undefined, new Date(at)).accepted).toBe(false)
    const english = mergeDiscoveryScope(raw, { ...draft, titleEquals: ['Product Manager'], titleExcludes: [] }, at)
    expect(evaluateDiscoveryCandidate(english, { ...candidate, role: ' PRODUCT   manager ' }, undefined, new Date(at)).accepted).toBe(true)
  })
  it('rejects contradictory exact conditions, unsupported instructions and unknown fields', () => {
    const draft = proposeSearchScope('产品经理')
    expect(() => mergeDiscoveryScope(undefined, { ...draft, titleEquals: ['产品经理'], titleExcludes: ['产品'] }, at)).toThrow('冲突')
    expect(() => proposeSearchScope('替我开通收费搜索', draft)).toThrow()
    expect(() => discoveryScopeSchema.parse({ ...draft, automationEnabled: true })).toThrow()
    expect(discoverySearchScope(createDefaultDiscoveryProfile(at)).titleEquals).toEqual([])
  })
})
