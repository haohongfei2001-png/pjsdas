import { describe, expect, it } from 'vitest'
import {
  savePendingOwnerConsent,
  readPendingOwnerConsent,
  clearPendingOwnerConsent,
} from '../src/aiAccess/ownerConsentPending.js'
import type { OwnerConsentDecision } from '../src/aiAccess/ownerManagementConsentClient.js'
const owner = '00000000-0000-4000-8000-000000000001',
  other = '00000000-0000-4000-8000-000000000002'
const body: OwnerConsentDecision = {
  requestId: '00000000-0000-4000-8000-000000000003',
  expectedAccountId: owner,
  clientId: '00000000-0000-4000-8000-000000000004',
  decision: 'approve',
  consentVersion: 2,
  consentTextHash: 'a'.repeat(64),
  expectedGrant: null,
  confirmed: true,
}
function fixture() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
}
describe('per-tab account-isolated uncertain consent recovery', () => {
  it('restores exact frozen metadata after page/controller recreation without storing credentials', () => {
    const s = fixture()
    savePendingOwnerConsent(body, s)
    const restored = readPendingOwnerConsent(owner, s)
    expect(restored).toEqual(body)
    expect(Object.isFrozen(restored)).toBe(true)
    expect([...s.data.values()].join()).not.toMatch(
      /access_token|refresh_token|authorization/i,
    )
  })
  it('never exposes another account pending request', () => {
    const s = fixture()
    savePendingOwnerConsent(body, s)
    expect(readPendingOwnerConsent(other, s)).toBeNull()
    expect(readPendingOwnerConsent(owner, s)).toEqual(body)
  })
  it('keeps uncertain metadata until an explicit successful resolution clears it', () => {
    const s = fixture()
    savePendingOwnerConsent(body, s)
    expect(readPendingOwnerConsent(owner, s)?.requestId).toBe(body.requestId)
    expect(clearPendingOwnerConsent(body, s)).toBe(true)
    expect(readPendingOwnerConsent(owner, s)).toBeNull()
  })
  it('cannot overwrite or clear a different pending request from a newer document', () => {
    const s = fixture()
    const newer = { ...body, requestId: '00000000-0000-4000-8000-000000000005' }
    savePendingOwnerConsent(newer, s)
    expect(() => savePendingOwnerConsent(body, s)).toThrow(/不能覆盖/)
    expect(clearPendingOwnerConsent(body, s)).toBe(false)
    expect(readPendingOwnerConsent(owner, s)).toEqual(newer)
  })
  it('cannot reuse a pending request ID for a different decision', () => {
    const s = fixture()
    savePendingOwnerConsent(body, s)
    expect(() =>
      savePendingOwnerConsent({ ...body, decision: 'revoke' }, s),
    ).toThrow(/不能覆盖/)
    expect(clearPendingOwnerConsent({ ...body, decision: 'revoke' }, s)).toBe(
      false,
    )
  })
  it('refuses malformed or injected metadata and storage failure', () => {
    const s = fixture()
    expect(() =>
      savePendingOwnerConsent(
        { ...body, access_token: 'synthetic' } as OwnerConsentDecision,
        s,
      ),
    ).toThrow()
    s.setItem(
      'todayaction-owner-consent-pending-v2:' + owner,
      JSON.stringify({ ...body, expectedAccountId: other }),
    )
    expect(() => readPendingOwnerConsent(owner, s)).toThrow()
    expect(() =>
      savePendingOwnerConsent(body, {
        ...fixture(),
        setItem: () => {
          throw new Error('quota')
        },
      }),
    ).toThrow(/尚未发送/)
    expect(
      clearPendingOwnerConsent(body, {
        ...fixture(),
        removeItem: () => {
          throw new Error('blocked')
        },
      }),
    ).toBe(false)
  })
})
