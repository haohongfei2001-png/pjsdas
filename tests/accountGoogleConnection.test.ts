import { describe, expect, it } from 'vitest'
import { accountGoogleConnection, accountGoogleConnectionLabel } from '../src/cloud/accountGoogleConnection.js'

const linked = { verified: true, googleEmail: 'synthetic@example.test' }

describe('unified account Google connection presentation', () => {
  it('does not turn missing or stale status into a successful connection', () => {
    expect(accountGoogleConnection({ verified: false })).toBe('unverified')
    expect(accountGoogleConnection({ ...linked, verified: false })).toBe('unverified')
    expect(accountGoogleConnection({ verified: true })).toBe('not_connected')
    expect(accountGoogleConnection(linked)).toBe('connected')
  })
  it.each(['GOOGLE_AUTH_EXPIRED', 'GOOGLE_CONNECTION_REQUIRED', 'GOOGLE_ACCOUNT_MISMATCH'])('preserves shared Google repair state for %s from either source', code => {
    expect(accountGoogleConnection({ ...linked, gmailLastError: `${code}: details` })).toBe('reconnect_required')
    expect(accountGoogleConnection({ ...linked, discoveryLastError: `${code}: details` })).toBe('reconnect_required')
  })
  it.each(['GOOGLE_AUTH_CONFIG_INVALID', 'GOOGLE_REFRESH_STORAGE_REQUIRED'])('does not mistake configuration error %s for revoked consent', code => {
    expect(accountGoogleConnection({ ...linked, gmailLastError: `${code}: details` })).toBe('configuration_error')
  })
  it('keeps Gmail-only permissions and transient source failures separate', () => {
    expect(accountGoogleConnection({ ...linked, gmailLastError: 'GOOGLE_GMAIL_SCOPE_MISSING: reauthorize Gmail' })).toBe('connected')
    expect(accountGoogleConnection({ ...linked, gmailLastError: 'GOOGLE_DRIVE_UNAVAILABLE: retry later' })).toBe('connected')
    expect(accountGoogleConnection({ ...linked, discoveryLastError: 'DISCOVERY_TIMEOUT' })).toBe('connected')
  })
  it('localizes unknown and repair without describing them as healthy', () => {
    expect(accountGoogleConnectionLabel('unverified', true)).toBe('连接待核对')
    expect(accountGoogleConnectionLabel('reconnect_required', false)).toBe('Reconnect Google')
  })
})
