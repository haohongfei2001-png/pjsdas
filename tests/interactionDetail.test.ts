import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const detail = readFileSync(new URL('../src/OpportunityDetailDrawer.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/interactionDetail.css', import.meta.url), 'utf8')

describe('v1.8 Round 2 interaction and detail experience', () => {
  it('uses one read-only opportunity detail layer across Today, Opportunities and Pipeline', () => {
    expect(app).toContain('<OpportunityDetailDrawer')
    expect(app).toContain('onOpenOpportunity={setSelectedOpportunityId}')
    expect(app).toContain('OpportunityTable opportunities={opportunities} groups={groups} onOpenOpportunity={onOpenOpportunity}')
    expect(app).toContain('PipelinePanel processes={processes} opportunities={opportunities} onOpenOpportunity={onOpenOpportunity}')
    expect(detail).toContain('RichOpportunityFactsSummary')
    expect(detail).toContain('OpportunityAssessmentSummary')
    expect(detail).toContain('jobPostingFreshness')
    expect(detail).not.toContain("from './db.js'")
  })

  it('keeps cross-surface navigation explicit at the app layer', () => {
    expect(app).toContain("const [decideTab, setDecideTab] = useState<DecideTab>('review')")
    expect(app).toContain("if (destination === 'opportunities')")
    expect(app).toContain("if (destination === 'pipeline')")
    expect(app).toContain("if (destination === 'prepare')")
    expect(detail).toContain("onNavigate('pipeline')")
    expect(detail).toContain("onNavigate('prepare')")
  })

  it('provides narrow-screen interaction instead of desktop-table overflow as the primary mobile experience', () => {
    expect(app).toContain('surface-opportunity-mobile-list')
    expect(css).toContain('.surface-opportunity-desktop{display:none}')
    expect(css).toContain('grid-template-columns:repeat(5,minmax(0,1fr))')
    expect(css).toContain('position:fixed!important')
    expect(css).toContain('bottom:0')
  })
})
