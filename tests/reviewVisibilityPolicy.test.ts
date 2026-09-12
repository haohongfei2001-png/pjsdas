import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')

describe('primary-surface attention policy', () => {
  it('does not expose review as a primary Decide context or visible pipeline field', () => {
    expect(app).toContain("type DecideTab = 'opportunities' | 'pipeline'")
    expect(app).not.toContain("'review' | 'opportunities'")
    expect(app).not.toContain('发现与审阅')
    expect(app).not.toContain('待复核岗位')
    expect(app).not.toContain('下次复核')
    expect(app).not.toContain('processNeedsReview')
    expect(app).not.toContain('processReviewLabel')
    expect(app).not.toContain('discoveryReviewCount')
    expect(app).not.toContain('复核队列')
  })

  it('keeps review-like maintenance as background state rather than ordering the visible pipeline', () => {
    expect(app).toContain("stageOrder[a.stage] - stageOrder[b.stage]")
    expect(app).toContain("(b.lastProgressAt ?? '').localeCompare(a.lastProgressAt ?? '')")
    expect(app).not.toContain('nextCheckAt')
  })
})
