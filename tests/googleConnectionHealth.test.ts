import { describe, expect, it } from 'vitest'
import { googleConnectionHealth, googleConnectionHealthLabel } from '../src/googleConnectionHealth.js'
const current = { verified: true, enabled: true, now: Date.parse('2026-10-05T20:00:00Z'), lastSuccessAt: '2026-10-05T19:55:00Z' }
describe('truthful Google connection health', () => {
  it('distinguishes invalid consent, configuration, transient and unverified states', () => {
    expect(googleConnectionHealth({ ...current, lastError: 'GOOGLE_AUTH_EXPIRED: reconnect', enabled: false })).toBe('reconnect_required')
    expect(googleConnectionHealth({ ...current, lastError: 'GOOGLE_AUTH_CONFIG_INVALID: config' })).toBe('configuration_error')
    expect(googleConnectionHealth({ ...current, lastError: 'GOOGLE_DRIVE_UNAVAILABLE: temporary' })).toBe('retrying')
    expect(googleConnectionHealth({ ...current, verified: false, lastError: 'GOOGLE_AUTH_EXPIRED: old' })).toBe('unverified')
  })
  it('does not turn enabled or fresh attempts into durable success', () => {
    expect(googleConnectionHealth({ ...current, lastSuccessAt: null })).toBe('waiting')
    expect(googleConnectionHealth({ ...current, lastSuccessAt: '2026-10-04T12:30:00Z' })).toBe('stale')
    expect(googleConnectionHealth(current)).toBe('current')
    expect(googleConnectionHealth({ ...current, enabled: false })).toBe('disabled')
  })
  it.each(['GOOGLE_AUTH_EXPIRED', 'GOOGLE_AUTH_EXPIRED [profile] HTTP 401', 'GOOGLE_AUTH_EXPIRED: reconnect'])('recognizes stored error format %s', (lastError) => {
    expect(googleConnectionHealth({ ...current, lastError })).toBe('reconnect_required')
  })
  it('does not match prefixes and uses the 20-minute registry SLA', () => {
    expect(googleConnectionHealth({ ...current, lastError: 'GOOGLE_AUTH_EXPIRED_NOT' })).toBe('retrying')
    expect(googleConnectionHealth({ ...current, lastSuccessAt: '2026-10-05T19:39:00Z' })).toBe('stale')
  })
  it('has distinct translated reconnect and retry labels', () => {
    expect(googleConnectionHealthLabel('reconnect_required', true)).toContain('重新连接')
    expect(googleConnectionHealthLabel('retrying', false)).toContain('Retry pending')
  })
})
