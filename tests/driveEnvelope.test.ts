import { describe, expect, it } from 'vitest'
import { createSnapshot } from '../src/snapshot'
import { createDriveWorkspaceEnvelope, parseDriveWorkspaceEnvelope } from '../src/cloud/driveEnvelope'

const empty = createSnapshot({
  opportunities: [],
  processes: [],
  processEvents: [],
  actions: [],
  prep: [],
  applicationGroups: [],
}, '2026-09-11T00:00:00.000Z')

describe('Google Drive workspace envelope', () => {
  it('round-trips normalized workspace metadata', () => {
    const envelope = createDriveWorkspaceEnvelope({ fingerprint: 'abc', deviceId: 'device-1', snapshot: empty, updatedAt: '2026-09-11T01:00:00.000Z' })
    expect(parseDriveWorkspaceEnvelope(envelope)).toEqual(envelope)
  })

  it('rejects unrelated JSON files', () => {
    expect(() => parseDriveWorkspaceEnvelope({ hello: 'world' })).toThrow(/版本|格式/)
  })
})
