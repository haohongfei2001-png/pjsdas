import { upgradeSnapshotToLatest, type PJSDASSnapshot } from './snapshot.js'
/** Preserve historical input to normalization without cloning its private payload. */
export function readModelSnapshot(raw: PJSDASSnapshot): PJSDASSnapshot {
  return upgradeSnapshotToLatest(raw, { readOnlyHistory: true })
}
