import { describe, expect, it } from 'vitest'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { discoveryInboxItemsFromChangeSet } from '../src/discoveryInbox.js'
import { createSnapshot } from '../src/snapshot.js'
import { diffCommandObjects, overlappingCommandObjects } from '../gateway/commandObjects.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const time = '2026-09-24T00:00:00.000Z'

function workspace() {
  return createSnapshot({
    opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
    discoveryProfile: createDefaultDiscoveryProfile(time), discoveryInbox: [], timeline: [], changeSets: [],
  }, time)
}

function incomingChangeSet(): ChangeSetRecord {
  return {
    id: 'CS-CGR05-001', version: 1, source: 'mcp', status: 'pending', title: 'Discovery',
    createdAt: time, updatedAt: time,
    operations: [{
      id: 'discovery:add:cgr05-1', kind: 'add_discovered_opportunity', summary: 'New job',
      opportunity: {
        id: 'cgr05-1', company: 'Example', role: 'Designer', currentStageLabel: 'New',
        processStage: 'not_applied', roleType: 'core', early: false,
        opportunityValue: 70, fitScore: 75, locallyManaged: true, importedAt: time,
        detail: { discovery: {
          sourceUrl: 'https://example.com/job/1', sourceTitle: 'Designer',
          rationale: 'Visible source facts', discoveredAt: time,
          fitConfidence: 'medium', opportunityValueConfidence: 'medium',
        } },
      },
    }],
  }
}

describe('connected compatibility receipt scope', () => {
  it('records discovery and profile writes so subsequent object-scoped commands can detect overlap', () => {
    const before = workspace()
    const after = structuredClone(before)
    const [item] = discoveryInboxItemsFromChangeSet(incomingChangeSet(), new Date(time))
    after.data.discoveryInbox = [item]
    after.data.discoveryProfile = {
      ...after.data.discoveryProfile!, targetRoleQueries: ['Designer'], updatedAt: time,
    }
    const affected = diffCommandObjects(before, after)
    expect(affected).toContainEqual({ type: 'discovery_inbox', id: item.id })
    expect(affected).toContainEqual({ type: 'discovery_profile', id: 'current' })
    expect(overlappingCommandObjects([{ type: 'discovery_inbox', id: item.id }], affected))
      .toEqual([{ type: 'discovery_inbox', id: item.id }])
  })
})
