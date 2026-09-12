import { describe, expect, it } from 'vitest'
import {
  canonicalizeJobSourceUrl,
  createJobPostingEvidence,
  jobPostingFreshness,
  logicalJobMatches,
  mergeJobPostingEvidence,
} from '../src/jobPosting.js'

describe('v1.4 Round 3 job posting identity and freshness', () => {
  it('canonicalizes tracking variants of the same public source URL', () => {
    const a = canonicalizeJobSourceUrl('https://careers.example.com/jobs/123/?utm_source=chatgpt&ref=home#apply')
    const b = canonicalizeJobSourceUrl('https://careers.example.com/jobs/123')
    expect(a).toBe(b)
  })

  it('treats reordered role titles as the same logical job while respecting known location conflicts', () => {
    expect(logicalJobMatches(
      { company: '候选科技有限公司', role: '产品经理（AI方向）', location: '北京' },
      { company: '候选科技', role: 'AI 产品经理', location: '北京' },
    )).toBe(true)
    expect(logicalJobMatches(
      { company: '候选科技', role: 'AI 产品经理', location: '北京' },
      { company: '候选科技', role: 'AI 产品经理', location: '深圳' },
    )).toBe(false)
  })

  it('classifies recent, aging, stale and closed posting evidence deterministically', () => {
    const base = createJobPostingEvidence({
      company: '候选科技', role: 'AI 产品经理', sourceUrl: 'https://careers.example.com/jobs/1', sourceTitle: 'AI PM',
      postingStatus: 'open', observedAt: '2026-09-01T00:00:00.000Z',
    })
    expect(jobPostingFreshness(base, new Date('2026-09-05T00:00:00.000Z'))).toBe('fresh')
    expect(jobPostingFreshness(base, new Date('2026-09-12T00:00:00.000Z'))).toBe('aging')
    expect(jobPostingFreshness(base, new Date('2026-09-25T00:00:00.000Z'))).toBe('stale')
    expect(jobPostingFreshness({ ...base, postingStatus: 'closed' }, new Date('2026-09-05T00:00:00.000Z'))).toBe('closed')
  })

  it('refreshes the same source without losing its first-seen time', () => {
    const first = createJobPostingEvidence({
      company: '候选科技', role: 'AI 产品经理', sourceUrl: 'https://careers.example.com/jobs/1?utm_source=a', sourceTitle: 'AI PM',
      postingStatus: 'unknown', observedAt: '2026-09-01T00:00:00.000Z',
    })
    const refreshed = createJobPostingEvidence({
      company: '候选科技', role: 'AI 产品经理', sourceUrl: 'https://careers.example.com/jobs/1?utm_source=b', sourceTitle: 'AI PM',
      postingStatus: 'open', observedAt: '2026-09-10T00:00:00.000Z',
    })
    const merged = mergeJobPostingEvidence(first, [], refreshed, new Date('2026-09-10T00:00:00.000Z'))
    expect(merged.current.id).toBe(first.id)
    expect(merged.current.firstSeenAt).toBe('2026-09-01T00:00:00.000Z')
    expect(merged.current.lastVerifiedAt).toBe('2026-09-10T00:00:00.000Z')
    expect(merged.current.postingStatus).toBe('open')
    expect(merged.history).toHaveLength(0)
  })

  it('retains an older stale source when a new source replaces it', () => {
    const oldPosting = createJobPostingEvidence({
      company: '候选科技', role: 'AI 产品经理', sourceUrl: 'https://jobs.example.com/old', sourceTitle: 'Old AI PM',
      postingStatus: 'open', observedAt: '2026-08-01T00:00:00.000Z',
    })
    const newPosting = createJobPostingEvidence({
      company: '候选科技', role: 'AI 产品经理', sourceUrl: 'https://careers.example.com/new', sourceTitle: 'New AI PM',
      postingStatus: 'open', observedAt: '2026-09-10T00:00:00.000Z',
    })
    const merged = mergeJobPostingEvidence(oldPosting, [], newPosting, new Date('2026-09-10T00:00:00.000Z'))
    expect(merged.current.id).toBe(newPosting.id)
    expect(merged.history).toHaveLength(1)
    expect(merged.history[0].supersededByPostingId).toBe(newPosting.id)
  })
})
