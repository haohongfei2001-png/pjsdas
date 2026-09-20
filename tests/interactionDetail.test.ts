import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const detail = readFileSync(new URL('../src/OpportunityDetailDrawer.tsx', import.meta.url), 'utf8')
const interactionCss = readFileSync(new URL('../src/interactionDetail.css', import.meta.url), 'utf8')
const ultimateCss = readFileSync(new URL('../src/ultimateWeb.css', import.meta.url), 'utf8')

describe('opportunity detail and navigation integration', () => {
  it('uses one read-only opportunity detail layer across Today, Opportunities and Pipeline', () => {
    expect(app).toContain('<OpportunityDetailDrawer')
    expect(app).toContain('function openOpportunity(id: string)')
    expect(app).toContain("navigate('/opportunities/' + encodeURIComponent(id))")
    expect(app).toContain('OpportunityTable opportunities={opportunities} groups={groups} onOpenOpportunity={onOpenOpportunity}')
    expect(app).toContain('PipelinePanel processes={processes} opportunities={opportunities} onOpenOpportunity={onOpenOpportunity}')
    expect(detail).toContain('RichOpportunityFactsSummary')
    expect(detail).toContain('OpportunityAssessmentSummary')
    expect(detail).toContain('jobPostingFreshness')
    expect(detail).not.toContain("from './db.js'")
  })

  it('keeps cross-surface navigation explicit at the app layer', () => {
    expect(app).toContain("const [opportunityTab, setOpportunityTab] = useState<OpportunityTab>('opportunities')")
    expect(app).toContain("if (destination === 'opportunities')")
    expect(app).toContain("if (destination === 'pipeline')")
    expect(app).toContain("if (destination === 'prepare')")
    expect(detail).toContain("onNavigate('pipeline')")
    expect(detail).toContain("onNavigate('prepare')")
  })

  it('provides an iPhone-first list and two-destination bottom navigation instead of desktop-table overflow', () => {
    expect(app).toContain('surface-opportunity-mobile-list')
    expect(interactionCss).toContain('.surface-opportunity-desktop{display:none}')
    expect(ultimateCss).toContain('grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(ultimateCss).toContain('.ultimate-mobile-capture')
    expect(ultimateCss).toContain('position:fixed')
    expect(ultimateCss).toContain('safe-area-inset-bottom')
  })
})
