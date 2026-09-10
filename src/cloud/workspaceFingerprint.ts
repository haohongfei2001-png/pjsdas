import { DEFAULT_DECISION_RULES } from '../decisionRules'
import type { PJSDASSnapshot } from '../snapshot'

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

function rulesAreDefault(snapshot: PJSDASSnapshot) {
  const rules = snapshot.data.decisionRules
  if (!rules) return true
  const a = { ...rules, updatedAt: '', weights: { ...rules.weights } }
  const b = { ...DEFAULT_DECISION_RULES, updatedAt: '', weights: { ...DEFAULT_DECISION_RULES.weights } }
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
    (data.changeSets ?? []).length === 0 &&
    !meaningfulTimeline &&
    !data.meta &&
    rulesAreDefault(snapshot)
}
