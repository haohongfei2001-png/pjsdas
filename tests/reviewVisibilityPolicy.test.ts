import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const attention = readFileSync(new URL('../src/AttentionView.tsx', import.meta.url), 'utf8')
const timeline = readFileSync(new URL('../src/TimelineView.tsx', import.meta.url), 'utf8')

describe('primary-surface attention policy', () => {
  it('uses Attention as the explicit exception surface without reintroducing a Discovery review tab', () => {
    expect(app).toContain("'attention'")
    expect(app).toContain("type OpportunityTab = 'opportunities' | 'pipeline' | 'prepare'")
    expect(app).not.toContain("'review' | 'opportunities'")
    expect(attention).toContain("item.status === 'pending' || item.status === 'failed'")
    expect(attention).toContain('coverage.exceptions')
  })

  it('keeps Apply/Discard out of Activity', () => {
    expect(timeline).not.toContain('onApplyChangeSet')
    expect(timeline).not.toContain('onDiscardChangeSet')
    expect(timeline).not.toContain('changeset-ledger')
    expect(attention).toContain("void resolve(item, 'apply')")
    expect(attention).toContain("void resolve(item, 'discard')")
  })
})
