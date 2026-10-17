import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import OpportunityDetailDrawer from '../src/OpportunityDetailDrawer.js'
import { workspaceWriteIdentityMatches } from '../src/cloud/workspaceWriteLease.js'
import { readFileSync } from 'node:fs'
vi.mock('../src/uiLanguage.js', () => ({ useUiLanguage: () => ({ lang: 'en' }) }))

const opportunity = { id: 'synthetic-job', company: 'Example', role: 'Engineer', processStage: 'not_applied' } as Parameters<typeof OpportunityDetailDrawer>[0]['opportunity']
function render(blocked: boolean, fallback = false) {
  return renderToStaticMarkup(createElement(OpportunityDetailDrawer, {
    opportunity, actions: fallback ? [{ id: 'apply:synthetic-job', opportunityId: opportunity.id, kind: 'apply', status: 'todo', title: 'Apply' } as Parameters<typeof OpportunityDetailDrawer>[0]['actions'][number]] : [],
    decisionRequests: [], relatedPrep: [], timeline: [], asPage: true, writeBlocked: blocked,
    onClose() {}, onCapture() {}, onNavigate() {}, onOpenDecision() {}, onMarkAction: async () => {},
    onJobAction: fallback ? undefined : async () => {},
  }))
}
function submission(markup: string) { return markup.match(/<button[^>]*>I applied<\/button>/)?.[0] }

describe('job detail write admission', () => {
  it.each([false, true])('renders submission disabled until confirmation, including fallback=%s', fallback => {
    expect(submission(render(true, fallback))).toContain('disabled=""')
    expect(render(true, fallback)).toContain('Account not confirmed.')
    expect(submission(render(false, fallback))).toBe('<button type="button">I applied</button>')
    expect(render(false, fallback)).not.toContain('Account not confirmed.')
  })
  it('keeps resolved anonymous and matching bound authority distinct', () => {
    expect(workspaceWriteIdentityMatches(undefined, undefined, undefined)).toBe(true)
    expect(workspaceWriteIdentityMatches('owner', 'owner', 'owner')).toBe(true)
    expect(workspaceWriteIdentityMatches('owner', 'owner', undefined)).toBe(true)
    for (const [requested, active, owner] of [[undefined, undefined, 'owner'], [undefined, 'owner', undefined], ['owner', undefined, 'owner'], ['owner', 'other', 'owner'], ['other', 'other', 'owner']]) {
      expect(workspaceWriteIdentityMatches(requested, active, owner)).toBe(false)
    }
  })
  it('wires reactive cloud state and synchronous resolution into availability without replacing the lease', () => {
    const source = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
    expect(source).toContain('cloud.loading || !isAccountCacheSessionResolved()')
    expect(source).toContain('workspaceWriteIdentityMatches(cloud.session?.user.id, currentAccountCacheSession(), cloud.device.workspaceOwnerUserId)')
    expect(source).toContain('writeBlocked={jobWriteBlocked}')
    expect(source).toContain('const writeLease = captureWorkspaceWriteLease(accountKey)')
  })
})
