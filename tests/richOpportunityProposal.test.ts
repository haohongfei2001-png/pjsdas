import { describe, expect, it, vi } from 'vitest'
import { invokeProposeChanges } from '../gateway/proposeChanges.js'
import { verifySignedProposalToken } from '../gateway/proposalToken.js'
import { createFileWorkspaceSource, type WorkspaceSource } from '../gateway/workspaceSource.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { encodedProposalFromHash } from '../src/ai/mcpProposal.js'
import { discoveryInboxItemsFromChangeSet, inboxOpportunity } from '../src/discoveryInbox.js'
import { createOpportunityFacts } from '../src/richOpportunity.js'
import { applyVerifiedOpportunityCommand } from '../src/verifiedOpportunityCommand.js'
import { applyDomainCompensation } from '../src/domainCommands.js'
import { recruitingPagesFixture, verifiedPostingFixture } from './fixtures/verifiedDiscovery.js'
const signingKey = 'test-only-rich-opportunity-signing-key', at = '2026-09-12T02:00:00.000Z'
const base = createFileWorkspaceSource({ file: new URL('../gateway/fixtures/demo-workspace.json', import.meta.url), now: new Date(at), timezone: 'Asia/Shanghai', workspaceVersion: 'drive:15' })
const source: WorkspaceSource = { async read() { const workspace = await base.read(); return { ...workspace, snapshot: { ...workspace.snapshot,
  data: { ...workspace.snapshot.data, discoveryProfile: { ...createDefaultDiscoveryProfile(at), searchScopeVersion: 1, targetRoleQueries: ['AI 产品经理'], preferredLocations: ['北京'] } } } } } }
const candidate = { company: '丰富科技', role: 'AI 产品经理', sourceUrl: 'https://www.liepin.com/job/9431.shtml', sourceTitle: '丰富科技招聘页面', location: '北京', deadline: '2026-10-10', deadlinePrecision: 'date' as const }
const resultJson = (result: Awaited<ReturnType<typeof invokeProposeChanges>>) => JSON.parse(result.content.find(item => item.type === 'text')!.text!) as any

describe('minimal Discovery facts and legacy rich-data compatibility', () => {
  it('persists verified source facts without inventing a rich profile, salary or education', async () => {
    const result = await invokeProposeChanges(source, { discoveredOpportunities: [candidate] }, { signingKey, fetchImpl: recruitingPagesFixture([candidate]) })
    expect(result.isError).not.toBe(true)
    const token = encodedProposalFromHash(new URL(String(resultJson(result).reviewUrl)).hash)!
    const signed = await verifySignedProposalToken(token, signingKey, new Date('2026-09-12T02:01:00Z'))
    const operation = signed.changeSet.operations[0]
    expect(operation.kind).toBe('add_discovered_opportunity')
    if (operation.kind !== 'add_discovered_opportunity') throw new Error('Expected factual job')
    expect(operation.opportunity).toMatchObject({ company: candidate.company, role: candidate.role, deadline: '2026-10-10', deadlinePrecision: 'date' })
    expect(operation.opportunity.detail?.facts).toBeUndefined()
    expect(operation.opportunity.detail?.discovery).toMatchObject({ sourceVerification: 'verified', location: '北京' })
    expect(operation.opportunity.detail?.discovery).not.toHaveProperty('rationale')
    const [inbox] = discoveryInboxItemsFromChangeSet(signed.changeSet, new Date('2026-09-12T02:02:00Z'))
    const promoted = inboxOpportunity(inbox, new Date('2026-09-12T02:03:00Z'))
    expect(promoted.detail?.facts).toBeUndefined()
    expect(promoted.detail?.discovery?.posting?.sourceProof).toEqual(operation.opportunity.detail?.discovery?.posting?.sourceProof)
  })
  it.each([
    { facts: { department: 'AI 产品部', responsibilities: ['Model-authored responsibility'], educationRequirement: '硕士优先' } },
    { compensationText: '40-30 万/年', annualCompensationMinWan: 40, facts: { annualCompensationMaxWan: 30 } },
    { rationale: 'Value assessment', roleType: 'core', discoveredAt: at },
  ])('rejects retired enrichment input before reading the workspace: %#', async legacy => {
    const read = vi.fn(async () => { throw new Error('No workspace read should occur') })
    const fetchImpl = vi.fn(async () => { throw new Error('No source access should occur') })
    const result = await invokeProposeChanges({ read }, { discoveredOpportunities: [{ ...candidate, ...legacy }] }, { signingKey, fetchImpl })
    expect(result.isError).toBe(true); expect(read).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('keeps accepted historical rich facts byte-for-byte through an unrelated verified addition and Undo', async () => {
    const snapshot = (await source.read()).snapshot, old = snapshot.data.opportunities[0]
    old.detail ??= {}
    old.detail.facts = createOpportunityFacts({ sourceUrl: old.detail.discovery!.sourceUrl, sourceTitle: old.role, verifiedAt: at,
      compensationText: 'Historical salary text', annualCompensationMinWan: 25,
      facts: { department: 'Historical department', educationRequirement: 'Historical education', responsibilities: ['Historical responsibilities'], annualCompensationMaxWan: 35 } })
    const original = structuredClone(old.detail.facts)
    const added = applyVerifiedOpportunityCommand(snapshot, { kind: 'save_verified_discovery_opportunity', commandId: 'new-factual-job', opportunityId: 'new-factual-job', observation: await verifiedPostingFixture(candidate, at) }, new Date(at))
    expect(added.status).toBe('APPLIED')
    expect(added.snapshot.data.opportunities.find(item => item.id === old.id)?.detail?.facts).toEqual(original)
    if (added.status !== 'APPLIED') throw new Error('Expected new job')
    const restored = applyDomainCompensation(added.snapshot, added.compensation!, new Date('2026-09-12T02:04:00Z'))
    expect(restored.data.opportunities.find(item => item.id === old.id)?.detail?.facts).toEqual(original)
    expect(restored.data.opportunities.some(item => item.id === 'new-factual-job')).toBe(false)
  })
})
