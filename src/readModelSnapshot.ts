import { withoutPreparationSurfaces } from './preparationRetirement.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from './snapshot.js'
/** Preserve historical input to normalization without cloning its private payload. */
export function readModelSnapshot(raw: PJSDASSnapshot): PJSDASSnapshot {
  return withoutPreparationSurfaces(upgradeSnapshotToLatest(raw, { readOnlyHistory: true }))
}
