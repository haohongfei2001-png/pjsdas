import { describe, expect, it } from 'vitest'
import { recordCorrectionWorkspace } from './fixtures/recordCorrectionWorkspace.js'
import { applyJobViewedCommand, isUnreadJob } from '../src/jobReadState.js'
import { upgradeSnapshotToLatest, validateSnapshot } from '../src/snapshot.js'
import { applyWorkspaceDelta, diffWorkspaceDelta } from '../src/workspaceDelta.js'

describe('B3 account-workspace job read state', () => {
  it('keeps all historical and user-confirmed additions viewed without timestamp inference', () => {
    const snapshot = upgradeSnapshotToLatest(recordCorrectionWorkspace())
    expect(snapshot.data.opportunities.every(job => !isUnreadJob(job))).toBe(true)
    expect(applyJobViewedCommand(snapshot, snapshot.data.opportunities[0].id).changed).toBe(false)
  })
  it('marks only the opened background job, is idempotent, and survives export and delta replay', () => {
    const snapshot = upgradeSnapshotToLatest(recordCorrectionWorkspace())
    const job = snapshot.data.opportunities[0]
    job.discoveryRead = { version: 1, addedAt: '2026-10-17T01:00:00.000Z' }
    const result = applyJobViewedCommand(snapshot, job.id, new Date('2026-10-17T02:00:00.000Z'))
    expect(isUnreadJob(job)).toBe(true)
    expect(isUnreadJob(result.snapshot.data.opportunities[0])).toBe(false)
    expect(result.snapshot.data.actions).toEqual(snapshot.data.actions)
    expect(result.snapshot.data.scheduleNodes).toEqual(snapshot.data.scheduleNodes)
    expect(applyJobViewedCommand(result.snapshot, job.id).changed).toBe(false)
    expect(applyWorkspaceDelta(snapshot, diffWorkspaceDelta(snapshot, result.snapshot))).toEqual({ ...result.snapshot, exportedAt: snapshot.exportedAt })
    const restored = upgradeSnapshotToLatest(JSON.parse(JSON.stringify(result.snapshot)))
    expect(isUnreadJob(restored.data.opportunities[0])).toBe(false)
  })
  it('cannot view a job absent from this account or accept malformed metadata', () => {
    const snapshot = upgradeSnapshotToLatest(recordCorrectionWorkspace())
    expect(() => applyJobViewedCommand(snapshot, 'other-account-job')).toThrow('current workspace')
    snapshot.data.opportunities[0].discoveryRead = { version: 1, addedAt: 'invalid' }
    expect(() => validateSnapshot(snapshot)).toThrow()
  })
})
