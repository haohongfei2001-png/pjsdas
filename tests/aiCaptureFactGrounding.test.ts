import { describe, expect, it } from 'vitest'
import { createAiCaptureContractSession, type AiCaptureTrustedContext } from '../gateway/aiCaptureContract.js'

function review(text: string, candidate: Record<string, unknown>, quote = text, selected = false) {
  const context: AiCaptureTrustedContext = {
    trigger: 'explicit_user_request', ownerKey: 'synthetic-owner', inputId: 'synthetic-facts-001', receiptId: 'receipt-001', text,
    timezone: 'Asia/Shanghai', referenceTime: '2026-10-25T08:00:00Z', workspaceRevision: 'txn:42', statementMode: 'current_intent',
    temporalResolutionBasis: 'user_explicit', source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: 'record-001',
      sourceVersion: '1', observedAt: '2026-10-25T08:00:00Z', timezone: 'Asia/Shanghai' },
    ...(selected ? { contextRefs: ['opportunity:saved-job'] } : {}),
    opportunities: [{ opportunityId: 'saved-job', company: 'Acme', role: 'Engineer' }],
  }
  return createAiCaptureContractSession(context).evaluate({ contractVersion: 1, candidates: [{ ...candidate, confidence: 'high',
    evidence: { start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote } }], clarifications: [] }, context)
}

describe('AI candidate identity and URL grounding', () => {
  it('does not turn an unrelated exact quotation into invented job facts', () => {
    expect(review('明天买咖啡', { kind: 'user_opportunity', company: 'Invented Co', role: 'Designer' }).status).toBe('clarification_required')
  })
  it.each([
    ['New Co', 'Engineer'], ['New Co Engineer', 'Designer'], ['Other Co Engineer', 'Engineer'],
  ])('requires both names in the candidate evidence: %s', (text, role) => {
    expect(review(text, { kind: 'user_opportunity', company: 'New Co', role }).status).toBe('clarification_required')
  })
  it('does not borrow existing job identity from the private workspace inventory', () => {
    expect(review('明天买咖啡', { kind: 'application_action', target: { company: 'Acme', role: 'Engineer' } }).status).toBe('clarification_required')
  })
  it('does not let selected-job context supply unstated names', () => {
    expect(review('明天投递这个岗位', { kind: 'application_action', target: { company: 'Acme', role: 'Engineer' } }, '明天投递这个岗位', true).status).toBe('clarification_required')
  })
  it('does not borrow identity from a different evidence fragment', () => {
    expect(review('New Co Designer；明天买咖啡', { kind: 'user_opportunity', company: 'New Co', role: 'Designer' }, '明天买咖啡').status).toBe('clarification_required')
  })
  it('rejects a model-invented source URL even with grounded company and role', () => {
    expect(review('新增 New Co Designer', { kind: 'user_opportunity', company: 'New Co', role: 'Designer', sourceUrl: 'https://example.com/jobs/1' }).status).toBe('clarification_required')
  })
  it('does not accept partial names or URL prefixes', () => {
    expect(review('Pineapple Designer', { kind: 'user_opportunity', company: 'Apple', role: 'Designer' }).status).toBe('clarification_required')
    expect(review('New Co Designer https://example.com/jobs/12', { kind: 'user_opportunity', company: 'New Co', role: 'Designer', sourceUrl: 'https://example.com/jobs/1' }).status).toBe('clarification_required')
  })
  it('preserves URL punctuation, query strings and fragments exactly', () => {
    const candidate = { kind: 'user_opportunity', company: 'New Co', role: 'Designer' }
    for (const suffix of [')', '?team=a&role=b', '#apply']) {
      const sourceUrl = `https://example.com/jobs/1${suffix}`
      expect(review(`New Co Designer “${sourceUrl}”`, { ...candidate, sourceUrl }).status).toBe('ready_for_review')
      expect(review(`New Co Designer “${sourceUrl}”`, { ...candidate, sourceUrl: 'https://example.com/jobs/1' }).status).toBe('clarification_required')
    }
  })
  it('accepts exact source URLs and existing identity normalization, not aliases', () => {
    expect(review('新增 NEW  CO Designer https://example.com/jobs/1', { kind: 'user_opportunity', company: 'New Co', role: 'Designer', sourceUrl: 'https://example.com/jobs/1' }).status).toBe('ready_for_review')
    expect(review('明天投递 ACME Engineer', { kind: 'application_action', target: { company: 'Acme', role: 'Engineer' } }).status).toBe('ready_for_review')
  })
})
