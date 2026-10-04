import { expect, it, vi } from 'vitest'
import { createAudienceAccessGuard } from '../gateway/audienceAccess.js'
import { consumerReviewLeaseAllows } from '../gateway/consumerReviewLease.js'
import { newReviewPacket, reviewAudienceNote } from '../scripts/consumer-management/review-identities.js'
const now = Date.parse('2026-10-04T00:00:00.000Z'), start = new Date(now).toISOString(), expiresAt = new Date(now + 3600000).toISOString()
const packet = newReviewPacket({ expectedSha: 'a'.repeat(40), clientId: '00000000-0000-4000-8000-000000000081', expiresAt }, now)
const note = reviewAudienceNote(packet.manifest)
it('preserves all existing audience notes and rejects malformed or overlong dedicated leases', () => {
  for (const legacy of [undefined, null, '', 'Existing owner', 'Existing beta']) expect(consumerReviewLeaseAllows(legacy, undefined, now)).toBe(true)
  expect(consumerReviewLeaseAllows(note, start, now)).toBe(true)
  for (const invalid of ['TA_REVIEW_V7|', 'TA_REVIEW_V7|bad|bad', note + '|extra', note.replace(expiresAt, '2026-10-06T00:00:00.000Z')]) expect(consumerReviewLeaseAllows(invalid, start, now)).toBe(false)
  expect(consumerReviewLeaseAllows(note, undefined, now)).toBe(false)
  expect(consumerReviewLeaseAllows(note, start, Date.parse(expiresAt))).toBe(false)
  expect(consumerReviewLeaseAllows(note, start, Date.parse(expiresAt) + 1)).toBe(false)
})
it('the real audience guard rejects an expired test identity before workspace access, while a legacy owner is unchanged', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now)
  let marker: string | null = note, role = 'beta'
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json([{ user_id: packet.manifest.identities[0].id, email: packet.manifest.identities[0].email, role, revoked_at: null, granted_at: start, note: marker }]))
  const guard = createAudienceAccessGuard({ mode: 'allowlist', supabaseUrl: 'https://fixture.invalid', serviceRoleKey: 'synthetic', fetchImpl })
  const identity = { userId: packet.manifest.identities[0].id, email: packet.manifest.identities[0].email }
  try {
    expect(await guard(identity)).toMatchObject({ allowed: true, role: 'beta' })
    vi.setSystemTime(Date.parse(expiresAt))
    await expect(guard(identity)).rejects.toMatchObject({ code: 'AUDIENCE_ACCESS_REQUIRED' })
    marker = 'existing owner audit note'; role = 'owner'
    expect(await guard(identity)).toMatchObject({ allowed: true, role: 'owner' })
  } finally { vi.useRealTimers() }
})
