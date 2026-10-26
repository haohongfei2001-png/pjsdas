import { Buffer } from 'node:buffer'
import { createSnapshot, validateSnapshot } from '../../src/snapshot.js'
import { createDefaultDecisionRules } from '../../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../../src/discoveryProfile.js'
import { applyPlanningManagement, getPlanningManagementRead, restorePlanningManagement } from '../../src/planningManagement.js'
import { diffReadableWorkspaceRows } from '../../gateway/workspaceRowsCodec.js'

/** Legal retained passthrough fields, not an oversized command or a new quota. */
export async function largePlanningFixture() {
  const at = '2030-01-01T00:00:00.000Z'
  const before = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] }, at)
  const pad = <T extends object>(value: T) => {
    const padded = { ...value, retainedForwardMetadata: '' }
    padded.retainedForwardMetadata = 'x'.repeat(262_100 - Buffer.byteLength(JSON.stringify(padded)))
    return padded
  }
  before.data.decisionRules = pad(createDefaultDecisionRules(at))
  before.data.discoveryProfile = pad(createDefaultDiscoveryProfile(at))
  before.data.timePlanning = pad({ version: 1 as const, defaultDailyMinutes: 120, updatedAt: at })
  validateSnapshot(before)
  const read = await getPlanningManagementRead(before)
  const input = { operations: [{ kind: 'patch_time_preferences' as const, expectedFingerprint: read.timePreferences.fingerprint, patch: { defaultDailyMinutes: 121 } }] }
  const result = await applyPlanningManagement(before, input, 'synthetic-near-limit-planning', new Date(at))
  if (result.status !== 'APPLIED' || !result.compensation) throw Error('PLANNING_FIXTURE_NOT_APPLIED')
  const undo = restorePlanningManagement(result.snapshot, result.compensation, new Date(at))
  return { at, before, input, result, undo, delta: diffReadableWorkspaceRows(before, result.snapshot), undoDelta: diffReadableWorkspaceRows(result.snapshot, undo) }
}
