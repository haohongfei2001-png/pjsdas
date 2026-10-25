import { describe, expect, it } from 'vitest'
import { applyVerifiedDiscoveryCommand, type VerifiedDiscoveryCommand } from '../src/verifiedDiscoveryCommand.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { createSnapshot } from '../src/snapshot.js'

const at = '2026-10-25T00:00:00.000Z'
const url = 'https://careers.example.com/jobs/123'
const observation: VerifiedDiscoveryCommand['run']['observations'][number] = {
  sourceRecordId: 'stable:123', company: 'Example', role: 'Product Manager', sourceUrl: url, sourceTitle: 'Product Manager',
  sourceVerification: 'verified', sourceVerifiedAt: at, discoveredAt: at,
  sourceProof: { version: 1, authority: 'employer', authorityUrl: 'https://careers.example.com', requestedUrl: url, finalUrl: url,
    verifiedAt: at, documentSha256: 'a'.repeat(64), postingIdentity: 'stable:123', fields: [
      { field: 'company', value: 'Example', sourceUrl: url, selector: 'company', quote: 'Example' },
      { field: 'role', value: 'Product Manager', sourceUrl: url, selector: 'role', quote: 'Product Manager' },
    ] },
}
function command(id: string): VerifiedDiscoveryCommand {
  return { commandId: `command:${id}`, kind: 'ingest_verified_discovery', inputFingerprint: 'a'.repeat(64),
    run: { runId: id, sourceId: 'monitor:fixture', producer: 'mcp_trusted_ingestion', startedAt: at, completedAt: at, observations: [observation] } }
}
function snapshot(excluded = true) {
  return createSnapshot({ opportunities: [], actions: [], scheduleNodes: [], processes: [], processEvents: [], prep: [],
    applicationGroups: [], timeline: [], changeSets: [], discoveryProfile: { ...createDefaultDiscoveryProfile(at), mustNotHave: excluded ? ['Product'] : [] } }, at)
}
function apply(state: ReturnType<typeof snapshot>, id: string, hour = 1) {
  return applyVerifiedDiscoveryCommand(state, command(id), new Date(`2026-10-25T0${hour}:00:00.000Z`))
}

describe('verified Discovery reconsideration under current scope (offline)', () => {
  it.each([false, true])('admits unchanged verified facts after removing a prior exclusion (intermediate duplicate: %s)', intermediate => {
    const first = apply(snapshot(), 'initial')
    expect(first.ingestion.run.outcomes).toEqual({ filtered: 1 })
    const filteredHistory = structuredClone(first.snapshot.data.timeline)
    let state = first.snapshot
    if (intermediate) {
      const repeated = apply(state, 'still-excluded', 2)
      expect(repeated.ingestion.run.outcomes).toEqual({ duplicate: 1 })
      expect(repeated.snapshot.data.opportunities).toEqual([])
      state = repeated.snapshot
    }
    state.data.discoveryProfile!.mustNotHave = []
    const reconsidered = apply(state, 'now-allowed', 3)
    expect(reconsidered.ingestion.run.outcomes).toEqual({ created: 1 })
    expect(reconsidered.snapshot.data.opportunities).toHaveLength(1)
    expect(reconsidered.snapshot.data.actions).toEqual([])
    expect(reconsidered.snapshot.data.scheduleNodes).toEqual([])
    for (const old of filteredHistory) expect(reconsidered.snapshot.data.timeline).toContainEqual(old)
    const id = reconsidered.snapshot.data.opportunities[0].id
    const repeated = apply(reconsidered.snapshot, 'allowed-again', 4)
    expect(repeated.ingestion.run.outcomes).toEqual({ duplicate: 1 })
    expect(repeated.snapshot.data.opportunities.map(item => item.id)).toEqual([id])
    expect(repeated.ingestion.createdOpportunityIds).toEqual([])
    const replayed = apply(repeated.snapshot, 'now-allowed', 5)
    expect(replayed.status).toBe('ALREADY_APPLIED')
    expect(replayed.snapshot).toEqual(repeated.snapshot)
  })

  it('does not reconsider a completed run when only its scope later changes', () => {
    const first = apply(snapshot(), 'initial')
    first.snapshot.data.discoveryProfile!.mustNotHave = []
    const replayed = apply(first.snapshot, 'initial', 2)
    expect(replayed.status).toBe('ALREADY_APPLIED')
    expect(replayed.snapshot).toEqual(first.snapshot)
    expect(replayed.snapshot.data.opportunities).toEqual([])
  })

  it('keeps a still-excluded posting out and does not report a created result', () => {
    const first = apply(snapshot(), 'initial')
    first.snapshot.data.discoveryProfile!.mustNotHave = ['Product', 'Sales']
    const repeated = apply(first.snapshot, 'still-excluded', 2)
    expect(repeated.ingestion.run.outcomes).toEqual({ duplicate: 1 })
    expect(repeated.ingestion.createdOpportunityIds).toEqual([])
    expect(repeated.snapshot.data.opportunities).toEqual([])
  })

  it('does not delete an existing job when the scope narrows or recreate one removed after its recorded creation', () => {
    const first = apply(snapshot(false), 'created')
    const id = first.snapshot.data.opportunities[0].id
    first.snapshot.data.discoveryProfile!.mustNotHave = ['Product']
    const narrowed = apply(first.snapshot, 'narrowed', 2)
    expect(narrowed.snapshot.data.opportunities.map(item => item.id)).toEqual([id])
    expect(narrowed.ingestion.run.outcomes).toEqual({ duplicate: 1 })
    // Preserve historical creation evidence after a deliberate removal/Undo.
    narrowed.snapshot.data.opportunities = []
    narrowed.snapshot.data.discoveryProfile!.mustNotHave = []
    const afterRemoval = apply(narrowed.snapshot, 'after-removal', 3)
    expect(afterRemoval.ingestion.run.outcomes).toEqual({ duplicate: 1 })
    expect(afterRemoval.snapshot.data.opportunities).toEqual([])
  })
})
