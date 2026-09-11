import { describe, expect, it } from 'vitest'
import {
  createDefaultDiscoveryProfile,
  normalizeDiscoveryProfile,
  validateDiscoveryProfile,
} from '../src/discoveryProfile.js'

describe('Discovery Profile', () => {
  it('starts explicit and empty instead of inferring durable preferences', () => {
    const profile = createDefaultDiscoveryProfile('2026-09-11T03:30:00.000Z')
    expect(profile).toMatchObject({
      key: 'current',
      version: 1,
      targetRoleQueries: [],
      preferredLocations: [],
      mustHave: [],
      mustNotHave: [],
      strengths: [],
      updatedAt: '2026-09-11T03:30:00.000Z',
    })
    expect(validateDiscoveryProfile(profile)).toEqual([])
  })

  it('trims and de-duplicates user-entered discovery rules', () => {
    const profile = createDefaultDiscoveryProfile('2026-09-11T03:30:00.000Z')
    const normalized = normalizeDiscoveryProfile({
      ...profile,
      targetRoleQueries: [' AI 产品经理 ', 'ai 产品经理', '战略分析'],
      preferredLocations: ['北京', ' 北京 ', '上海'],
      mustHave: ['2027 届校招', '2027 届校招'],
      strengths: ['物理硕士', ' 物理硕士 '],
    }, '2026-09-11T03:31:00.000Z')

    expect(normalized.targetRoleQueries).toEqual(['AI 产品经理', '战略分析'])
    expect(normalized.preferredLocations).toEqual(['北京', '上海'])
    expect(normalized.mustHave).toEqual(['2027 届校招'])
    expect(normalized.strengths).toEqual(['物理硕士'])
    expect(validateDiscoveryProfile(normalized)).toEqual([])
  })

  it('rejects impossible compensation values and oversized durable lists', () => {
    const profile = createDefaultDiscoveryProfile('2026-09-11T03:30:00.000Z')
    expect(validateDiscoveryProfile({
      ...profile,
      minimumAnnualCompensationWan: -1,
    })).toContain('最低年薪必须位于 0–1000 万元。')

    expect(validateDiscoveryProfile({
      ...profile,
      targetRoleQueries: Array.from({ length: 31 }, (_, index) => `岗位 ${index}`),
    })).toContain('目标岗位 最多 30 项。')
  })
})
