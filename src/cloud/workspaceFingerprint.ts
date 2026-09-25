import { DEFAULT_DECISION_RULES } from '../decisionRules.js'
import { DEFAULT_DISCOVERY_PROFILE } from '../discoveryProfile.js'
import type { PJSDASSnapshot } from '../snapshot.js'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) next[key] = canonical(record[key])
    }
    return next
  }
  return value
}

export function canonicalWorkspaceJson(snapshot: PJSDASSnapshot) {
  return JSON.stringify(canonical(snapshot.data))
}

export async function fingerprintWorkspace(snapshot: PJSDASSnapshot) {
  const bytes = new TextEncoder().encode(canonicalWorkspaceJson(snapshot))
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持安全的工作区指纹计算。')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

// Local cache hydration materializes deterministic schedule, rules and system
// timeline projections. Trusted ingestion also appends server-only audit rows:
// those may be absent from an older cache without representing a local edit.
// Keep every local audit row in the comparison so local-only or altered
// evidence remains fail-closed.
function serverIngestionAudit(row: NonNullable<PJSDASSnapshot['data']['timeline']>[number]) {
  return (row.kind === 'ingestion_recorded' && Boolean(row.ingestion))
    || (row.kind === 'ingestion_run_completed' && Boolean(row.ingestionRun))
}

export function equivalentReadProjection(local: PJSDASSnapshot, remote: PJSDASSnapshot) {
  const localTimelineIds = new Set((local.data.timeline ?? []).map((row) => row.id))
  const normalized = (snapshot: PJSDASSnapshot, remoteSide: boolean) => {
    const data = structuredClone(snapshot.data)
    if (rulesAreDefault({ ...snapshot, data })) delete data.decisionRules
    const record = data as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        const rows = key === 'timeline'
          ? value.filter((row) => row?.kind !== 'baseline_backfill'
            && (!remoteSide || !serverIngestionAudit(row) || localTimelineIds.has(row.id)))
          : value
        if (rows.length) record[key] = rows
        else delete record[key]
      }
    }
    return JSON.stringify(canonical(data))
  }
  return normalized(local, false) === normalized(remote, true)
}

function rulesAreDefault(snapshot: PJSDASSnapshot) {
  const rules = snapshot.data.decisionRules
  if (!rules) return true
  const a = { ...rules, updatedAt: '', weights: { ...rules.weights } }
  const b = { ...DEFAULT_DECISION_RULES, updatedAt: '', weights: { ...DEFAULT_DECISION_RULES.weights } }
  return JSON.stringify(a) === JSON.stringify(b)
}

function discoveryProfileIsDefault(snapshot: PJSDASSnapshot) {
  const profile = snapshot.data.discoveryProfile
  if (!profile) return true
  const a = { ...profile, updatedAt: '' }
  const b = { ...DEFAULT_DISCOVERY_PROFILE, updatedAt: '' }
  return JSON.stringify(a) === JSON.stringify(b)
}

export function workspaceIsEffectivelyEmpty(snapshot: PJSDASSnapshot) {
  const data = snapshot.data
  const meaningfulTimeline = (data.timeline ?? []).some((item) => item.kind !== 'baseline_backfill' && item.source !== 'system')
  return data.opportunities.length === 0 &&
    data.processes.length === 0 &&
    data.processEvents.length === 0 &&
    data.actions.length === 0 &&
    data.prep.length === 0 &&
    data.applicationGroups.length === 0 &&
    (data.discoveryInbox ?? []).length === 0 &&
    (data.changeSets ?? []).length === 0 &&
    !meaningfulTimeline &&
    !data.meta &&
    rulesAreDefault(snapshot) &&
    discoveryProfileIsDefault(snapshot)
}
