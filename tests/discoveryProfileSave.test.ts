import { describe, expect, it } from 'vitest'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { discoveryProfileSavePayload } from '../src/discoveryProfileSave.js'

describe('discovery preference save after scoring retirement', () => {
  it('omits retired fields from connected write requests without changing the saved legacy profile', () => {
    const profile = { ...createDefaultDiscoveryProfile(), minimumFitScore: 75, minimumOpportunityValue: 80, targetRoleQueries: ['Product manager'], minimumAnnualCompensationWan: 25 }
    const payload = discoveryProfileSavePayload(profile)
    expect(payload).not.toHaveProperty('minimumFitScore')
    expect(payload).not.toHaveProperty('minimumOpportunityValue')
    expect(payload.targetRoleQueries).toEqual(['Product manager'])
    expect(payload).not.toHaveProperty('minimumAnnualCompensationWan')
    expect(profile.minimumAnnualCompensationWan).toBe(25)
    expect(profile.minimumFitScore).toBe(75)
    expect(profile.minimumOpportunityValue).toBe(80)
    expect(payload.targetRoleQueries).not.toBe(profile.targetRoleQueries)
  })

  it('retains all supported factual preference values and optional unknowns', () => {
    const profile = { ...createDefaultDiscoveryProfile(), preferredRoleTypes: ['core' as const], locationPolicy: 'strict' as const, preferredLocations: ['Shanghai'], locationNotes: 'Remote accepted', mustHave: ['SQL'], mustNotHave: ['Agency'], strengths: ['Research'], notes: 'Full time', maxReviewCandidates: 4, searchGoal: 'Explicit product search', titleIncludes: ['Product'], titleExcludes: ['Sales'] }
    const payload = discoveryProfileSavePayload(profile)
    expect(payload).toMatchObject({ locationPolicy: 'strict', preferredLocations: ['Shanghai'], mustHave: ['SQL'], mustNotHave: ['Agency'], searchGoal: 'Explicit product search', titleIncludes: ['Product'], titleExcludes: ['Sales'] })
    for (const key of ['preferredRoleTypes','locationNotes','strengths','notes','maxReviewCandidates']) expect(payload).not.toHaveProperty(key)
    expect(profile).toMatchObject({ notes: 'Full time', strengths: ['Research'], maxReviewCandidates: 4 })
    expect(payload.minimumAnnualCompensationWan).toBeUndefined()
  })
})
