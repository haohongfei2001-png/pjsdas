import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import OpportunityDetailDrawer from '../src/OpportunityDetailDrawer.js'
vi.mock('../src/uiLanguage.js', () => ({ useUiLanguage: () => ({ lang: 'zh' }) }))
const job = { id: 'synthetic', company: 'Synthetic', role: 'Analyst', processStage: 'not_applied' } as Parameters<typeof OpportunityDetailDrawer>[0]['opportunity']
function render(patch: Record<string, unknown> = {}, blocked = false, readOnly = false) {
  return renderToStaticMarkup(createElement(OpportunityDetailDrawer, { opportunity: { ...job, ...patch }, actions: [], decisionRequests: [], timeline: [], asPage: true,
    writeBlocked: blocked, readOnly, onClose() {}, onCapture() {}, onNavigate() {}, onOpenDecision() {}, onMarkAction: async () => {}, onStopFollowingChanged: async () => {} }))
}
describe('approved contextual stop-following surface (SSR/source only, no browser clicks)', () => {
  it.each(['not_applied', 'screening', 'interview', 'closed'])('does not restrict internal participation to an unsubmitted job: %s', processStage => {
    expect(render({ processStage })).toContain('>不再跟进</button>')
  })
  it('blocks unresolved write identity, hides read-only control, and never infers Undo from participation alone', () => {
    expect(render({}, true)).toMatch(/<button[^>]*class="job-detail-stop"[^>]*disabled=""[^>]*>不再跟进<\/button>/)
    expect(render({}, false, true)).not.toContain('job-detail-stop')
    const abandoned = render({ participationStatus: 'abandoned' })
    expect(abandoned).toContain('历史和招聘方流程保留')
    expect(abandoned).not.toContain('>撤销不再跟进</button>')
    expect(abandoned).not.toContain('>不再跟进</button>')
  })
  it('keeps explicit actions, no new confirmation modal, and no command dispatched by lifecycle effects', () => {
    const component = readFileSync(new URL('../src/jobs/StopFollowingAction.tsx', import.meta.url), 'utf8')
    const effects = component.slice(component.indexOf('  useEffect('), component.indexOf('  async function run'))
    expect(effects).toContain('inspectStopFollowing'); expect(effects).not.toContain('stopFollowing(')
    expect(component).toContain('const observed = ++sequence.current')
    expect(component).toContain('sequence.current += 1')
    expect(component).toContain('原操作尚未确认是否发送')
    expect(component).toContain('当前岗位状态以后续记录为准')
    expect(component).not.toContain('window.confirm'); expect(component).not.toContain('beginInstantCommand')
    expect(component).not.toContain('page.evaluate'); expect(component).not.toContain('dispatchEvent(')
    const detail = readFileSync(new URL('../src/OpportunityDetailDrawer.tsx', import.meta.url), 'utf8')
    expect(detail).toContain("key={`${accountKey ?? 'local'}:${opportunity.id}`}")
    expect(readFileSync(new URL('../src/jobs/jobDetail.css', import.meta.url), 'utf8')).toContain('.job-stop-following button{min-height:44px')
  })
})
