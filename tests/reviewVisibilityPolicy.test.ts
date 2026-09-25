import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const decisions = readFileSync(new URL('../src/DecisionRequestsView.tsx', import.meta.url), 'utf8')
const timeline = readFileSync(new URL('../src/TimelineView.tsx', import.meta.url), 'utf8')

describe('UU-04 decision visibility policy', () => {
  it('shows durable DecisionRequests in Today without adding a primary destination', () => {
    expect(app).toContain("'decisions'")
    expect(app).toContain('onOpenDecision={(id) => navigate')
    expect(app).toContain("const primarySurfaces: PrimarySurface[] = ['today', 'opportunities', 'schedule']")
    expect(app).toContain("navigate('/decisions')")
    expect(app).not.toContain("'review' | 'opportunities'")
    expect(decisions).toContain("item.state === 'open'")
    expect(decisions).toContain('request.choices.map')
    expect(decisions).toContain('resolveWebDecision')
    expect(decisions).not.toContain('ChangeSet')
  })

  it('keeps governed ChangeSet internals out of the daily Decisions and History surfaces', () => {
    expect(timeline).not.toContain('onApplyChangeSet')
    expect(timeline).not.toContain('onDiscardChangeSet')
    expect(timeline).not.toContain('changeset-ledger')
    expect(decisions).not.toContain('onApplyChangeSet')
    expect(decisions).not.toContain('onDiscardChangeSet')
  })
})
