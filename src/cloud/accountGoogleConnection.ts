import { googleAuthorizationErrorCode } from '../googleConnectionHealth.js'

export type AccountGoogleConnection = 'unverified' | 'not_connected' | 'reconnect_required' | 'configuration_error' | 'connected'

/** Presentation only: account sign-in is not proof of durable Google authorization. */
export function accountGoogleConnection(input: {
  verified: boolean
  googleEmail?: string | null
  gmailLastError?: string | null
  discoveryLastError?: string | null
}): AccountGoogleConnection {
  if (!input.verified) return 'unverified'
  const codes = [input.gmailLastError, input.discoveryLastError].map(googleAuthorizationErrorCode)
  if (codes.some(code => code === 'GOOGLE_AUTH_CONFIG_INVALID' || code === 'GOOGLE_REFRESH_STORAGE_REQUIRED')) return 'configuration_error'
  // A missing Gmail-only scope belongs to its own source, not the shared account link.
  if (codes.some(code => code === 'GOOGLE_AUTH_EXPIRED' || code === 'GOOGLE_CONNECTION_REQUIRED' || code === 'GOOGLE_ACCOUNT_MISMATCH')) return 'reconnect_required'
  return input.googleEmail ? 'connected' : 'not_connected'
}

export function accountGoogleConnectionLabel(state: AccountGoogleConnection, zh: boolean) {
  const labels: Record<AccountGoogleConnection, [string, string]> = {
    unverified: ['连接待核对', 'Connection unverified'],
    not_connected: ['需连接 Google', 'Connect Google'],
    reconnect_required: ['需重新连接 Google', 'Reconnect Google'],
    configuration_error: ['连接需要维护', 'Connection needs attention'],
    connected: ['Google 已连接', 'Google connected'],
  }
  return labels[state][zh ? 0 : 1]
}
