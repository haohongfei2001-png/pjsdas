import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

describe('v1.8 Round 4 usability friction removal', () => {
  it('keeps action completion reversible through the existing status ChangeSet path', () => {
    expect(app).toContain('lastCompletedAction')
    expect(app).toContain("applyActionStatusChangeSet(item.id, item.previousStatus)")
    expect(app).toContain('action-undo-toast')
    expect(app).not.toContain('updateActionStatus(')
  })

  it('adds a non-persistent start path for an empty workspace', () => {
    expect(app).toContain('workspaceEmpty')
    expect(app).toContain('GettingStartedCard')
    expect(app).toContain("onStart('review')")
    expect(app).toContain("onStart('settings')")
    expect(app).not.toContain('onboardingCompleted')
  })

  it('chooses Decide context from real workspace state until the user explicitly chooses', () => {
    expect(app).toContain('getAllDiscoveryInboxItems')
    expect(app).toContain('decideTabExplicit')
    expect(app).toContain("discoveryReviewCount > 0 ? 'review'")
    expect(app).toContain("setDecideTabExplicit(true)")
    expect(main.indexOf("import './usabilityFriction.css'")).toBeGreaterThan(main.indexOf("import './visualPolish.css'"))
  })
})
