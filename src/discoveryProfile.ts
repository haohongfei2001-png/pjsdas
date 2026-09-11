import type { OpportunityRole } from './model.js'

export const DISCOVERY_PROFILE_VERSION = 1 as const
export type DiscoveryLocationPolicy = 'prefer' | 'strict'

export interface DiscoveryProfile {
  key: 'current'
  version: typeof DISCOVERY_PROFILE_VERSION
  targetRoleQueries: string[]
  preferredLocations: string[]
  locationNotes: string
  minimumAnnualCompensationWan?: number
  preferredRoleTypes?: OpportunityRole[]
  locationPolicy?: DiscoveryLocationPolicy
  minimumFitScore?: number
  minimumOpportunityValue?: number
  maxReviewCandidates?: number
  mustHave: string[]
  mustNotHave: string[]
  strengths: string[]
  notes: string
  updatedAt: string
}

export const DEFAULT_DISCOVERY_PROFILE: DiscoveryProfile = {
  key: 'current',
  version: DISCOVERY_PROFILE_VERSION,
  targetRoleQueries: [],
  preferredLocations: [],
  locationNotes: '',
  minimumAnnualCompensationWan: undefined,
  preferredRoleTypes: [],
  locationPolicy: 'prefer',
  minimumFitScore: undefined,
  minimumOpportunityValue: undefined,
  maxReviewCandidates: 6,
  mustHave: [],
  mustNotHave: [],
  strengths: [],
  notes: '',
  updatedAt: '1970-01-01T00:00:00.000Z',
}

function normalizedStrings(values: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (!value) continue
    const key = value.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function normalizedRoleTypes(values: OpportunityRole[] | undefined) {
  const allowed = new Set<OpportunityRole>(['core', 'backup', 'reach', 'lottery', 'practice'])
  return [...new Set((values ?? []).filter((item): item is OpportunityRole => allowed.has(item)))]
}

export function cloneDiscoveryProfile(profile: DiscoveryProfile = DEFAULT_DISCOVERY_PROFILE): DiscoveryProfile {
  return {
    ...profile,
    targetRoleQueries: [...(profile.targetRoleQueries ?? [])],
    preferredLocations: [...(profile.preferredLocations ?? [])],
    preferredRoleTypes: normalizedRoleTypes(profile.preferredRoleTypes),
    locationPolicy: profile.locationPolicy ?? 'prefer',
    maxReviewCandidates: profile.maxReviewCandidates ?? 6,
    mustHave: [...(profile.mustHave ?? [])],
    mustNotHave: [...(profile.mustNotHave ?? [])],
    strengths: [...(profile.strengths ?? [])],
  }
}

export function createDefaultDiscoveryProfile(now = new Date().toISOString()): DiscoveryProfile {
  return { ...cloneDiscoveryProfile(DEFAULT_DISCOVERY_PROFILE), updatedAt: now }
}

export function discoveryProfileForSnapshot(profile?: DiscoveryProfile): DiscoveryProfile {
  return cloneDiscoveryProfile(profile ?? DEFAULT_DISCOVERY_PROFILE)
}

export function normalizeDiscoveryProfile(profile: DiscoveryProfile, now = new Date().toISOString()): DiscoveryProfile {
  return {
    ...profile,
    key: 'current',
    version: DISCOVERY_PROFILE_VERSION,
    targetRoleQueries: normalizedStrings(profile.targetRoleQueries ?? []),
    preferredLocations: normalizedStrings(profile.preferredLocations ?? []),
    locationNotes: (profile.locationNotes ?? '').trim(),
    preferredRoleTypes: normalizedRoleTypes(profile.preferredRoleTypes),
    locationPolicy: profile.locationPolicy ?? 'prefer',
    minimumFitScore: profile.minimumFitScore,
    minimumOpportunityValue: profile.minimumOpportunityValue,
    maxReviewCandidates: profile.maxReviewCandidates ?? 6,
    mustHave: normalizedStrings(profile.mustHave ?? []),
    mustNotHave: normalizedStrings(profile.mustNotHave ?? []),
    strengths: normalizedStrings(profile.strengths ?? []),
    notes: (profile.notes ?? '').trim(),
    minimumAnnualCompensationWan: profile.minimumAnnualCompensationWan,
    updatedAt: now,
  }
}

export function isDiscoveryProfileConfigured(profile: DiscoveryProfile) {
  const normalized = discoveryProfileForSnapshot(profile)
  return Boolean(
    normalized.targetRoleQueries.length ||
    normalized.preferredLocations.length ||
    normalized.locationNotes ||
    normalized.minimumAnnualCompensationWan !== undefined ||
    (normalized.preferredRoleTypes?.length ?? 0) ||
    normalized.minimumFitScore !== undefined ||
    normalized.minimumOpportunityValue !== undefined ||
    normalized.mustHave.length ||
    normalized.mustNotHave.length ||
    normalized.strengths.length ||
    normalized.notes
  )
}

export function validateDiscoveryProfile(profile: DiscoveryProfile): string[] {
  const errors: string[] = []
  if (profile.key !== 'current') errors.push('岗位发现偏好 key 必须为 current。')
  if (profile.version !== DISCOVERY_PROFILE_VERSION) errors.push('岗位发现偏好版本无效。')
  if (Number.isNaN(new Date(profile.updatedAt).getTime())) errors.push('岗位发现偏好更新时间无效。')

  const boundedList = (label: string, values: string[], maxItems: number) => {
    if (!Array.isArray(values)) {
      errors.push(`${label} 必须是数组。`)
      return
    }
    if (values.length > maxItems) errors.push(`${label} 最多 ${maxItems} 项。`)
    if (values.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.length > 160)) {
      errors.push(`${label} 包含无效文本。`)
    }
  }

  boundedList('目标岗位', profile.targetRoleQueries, 30)
  boundedList('偏好地点', profile.preferredLocations, 30)
  boundedList('必须满足', profile.mustHave, 30)
  boundedList('明确排除', profile.mustNotHave, 30)
  boundedList('个人优势', profile.strengths, 30)

  if (profile.preferredRoleTypes !== undefined) {
    const allowed = new Set(['core', 'backup', 'reach', 'lottery', 'practice'])
    if (!Array.isArray(profile.preferredRoleTypes) || profile.preferredRoleTypes.some((item) => !allowed.has(String(item)))) {
      errors.push('允许的岗位类型包含无效值。')
    }
  }
  if (profile.locationPolicy !== undefined && !['prefer', 'strict'].includes(profile.locationPolicy)) {
    errors.push('地点约束模式无效。')
  }

  if (typeof profile.locationNotes !== 'string' || profile.locationNotes.length > 1200) {
    errors.push('地点说明过长或格式无效。')
  }
  if (typeof profile.notes !== 'string' || profile.notes.length > 2400) {
    errors.push('岗位发现补充说明过长或格式无效。')
  }
  if (profile.minimumAnnualCompensationWan !== undefined) {
    const value = profile.minimumAnnualCompensationWan
    if (!Number.isFinite(value) || value < 0 || value > 1000) {
      errors.push('最低年薪必须位于 0–1000 万元。')
    }
  }
  for (const [label, value] of [
    ['最低匹配度', profile.minimumFitScore],
    ['最低机会价值', profile.minimumOpportunityValue],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100)) {
      errors.push(`${label}必须位于 0–100。`)
    }
  }
  if (profile.maxReviewCandidates !== undefined && (!Number.isInteger(profile.maxReviewCandidates) || profile.maxReviewCandidates < 1 || profile.maxReviewCandidates > 12)) {
    errors.push('单批最多审阅岗位数必须位于 1–12。')
  }
  return errors
}
