import { describe, expect, it } from 'vitest'
import {
  savePendingScopedConsent,
  readPendingScopedConsent,
  clearPendingScopedConsent,
} from '../src/aiAccess/scopedConsentPending.js'
import type { ScopedConsentDecision } from '../src/aiAccess/scopedManagementConsentClient.js'
const owner = '00000000-0000-4000-8000-000000000001',
  other = '00000000-0000-4000-8000-000000000002'
const body: ScopedConsentDecision = {
  requestId: '00000000-0000-4000-8000-000000000003',
  expectedAccountId: owner,
  clientId: '00000000-0000-4000-8000-000000000004',
  choices: [{ domain: 'planning', decision: 'approve', consentVersion: 4, consentTextHash: 'a'.repeat(64), expectedGrant: null }],
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
    savePendingScopedConsent(body, s)
    const restored = readPendingScopedConsent(owner, s)
    expect(restored).toEqual(body)
    expect(Object.isFrozen(restored)).toBe(true)
    expect([...s.data.values()].join()).not.toMatch(
      /access_token|refresh_token|authorization/i,
    )
  })
  it('never exposes another account pending request', () => {
    const s = fixture()
    savePendingScopedConsent(body, s)
    expect(readPendingScopedConsent(other, s)).toBeNull()
    expect(readPendingScopedConsent(owner, s)).toEqual(body)
  })
  it('keeps uncertain metadata until an explicit successful resolution clears it', () => {
    const s = fixture()
    savePendingScopedConsent(body, s)
    expect(readPendingScopedConsent(owner, s)?.requestId).toBe(body.requestId)
    expect(clearPendingScopedConsent(body, s)).toBe(true)
    expect(readPendingScopedConsent(owner, s)).toBeNull()
  })
  it('cannot overwrite or clear a different pending request from a newer document', () => {
    const s = fixture()
    const newer = { ...body, requestId: '00000000-0000-4000-8000-000000000005' }
    savePendingScopedConsent(newer, s)
    expect(() => savePendingScopedConsent(body, s)).toThrow(/不能覆盖/)
    expect(clearPendingScopedConsent(body, s)).toBe(false)
    expect(readPendingScopedConsent(owner, s)).toEqual(newer)
  })
  it('cannot reuse a pending request ID for a different decision', () => {
    const s = fixture()
    savePendingScopedConsent(body, s)
    expect(() =>
      savePendingScopedConsent({ ...body, choices: [{ ...body.choices[0], consentTextHash: 'b'.repeat(64) }] }, s),
    ).toThrow(/不能覆盖/)
    expect(clearPendingScopedConsent({ ...body, choices: [{ ...body.choices[0], consentTextHash: 'b'.repeat(64) }] }, s)).toBe(
      false,
    )
  })
  it('refuses malformed or injected metadata and storage failure', () => {
    const s = fixture()
    expect(() =>
      savePendingScopedConsent(
        { ...body, access_token: 'synthetic' } as ScopedConsentDecision,
        s,
      ),
    ).toThrow()
    s.setItem(
      'todayaction-scoped-consent-pending-v1:' + owner,
      JSON.stringify({ ...body, expectedAccountId: other }),
    )
    expect(() => readPendingScopedConsent(owner, s)).toThrow()
    expect(() =>
      savePendingScopedConsent(body, {
        ...fixture(),
        setItem: () => {
          throw new Error('quota')
        },
      }),
    ).toThrow(/尚未发送/)
    expect(
      clearPendingScopedConsent(body, {
        ...fixture(),
        removeItem: () => {
          throw new Error('blocked')
        },
      }),
    ).toBe(false)
  })
})
