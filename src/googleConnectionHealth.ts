import { bootstrapPolicyFor } from './sourceRegistry.js'

export function googleAuthorizationErrorCode(error?: string | null) {
  return /^[A-Z][A-Z0-9_]*(?=$|[:\s\[])/.exec(error ?? '')?.[0]
}

export type GoogleConnectionHealth = 'unverified' | 'reconnect_required' | 'configuration_error' | 'retrying' | 'disabled' | 'waiting' | 'stale' | 'current'

export function googleConnectionHealth(input: {
  verified: boolean
  enabled?: boolean
  lastError?: string | null
  lastSuccessAt?: string | null
  now?: number
  freshnessSlaMinutes?: number
}): GoogleConnectionHealth {
  if (!input.verified) return 'unverified'
  const code = googleAuthorizationErrorCode(input.lastError)
  if (code && ['GOOGLE_AUTH_EXPIRED', 'GOOGLE_CONNECTION_REQUIRED', 'GOOGLE_GMAIL_SCOPE_MISSING', 'GOOGLE_ACCOUNT_MISMATCH'].includes(code)) return 'reconnect_required'
  if (code === 'GOOGLE_AUTH_CONFIG_INVALID' || code === 'GOOGLE_REFRESH_STORAGE_REQUIRED') return 'configuration_error'
  if (!input.enabled) return 'disabled'
  if (input.lastError) return 'retrying'
  if (!input.lastSuccessAt) return 'waiting'
  const success = Date.parse(input.lastSuccessAt)
  if (!Number.isFinite(success) || (input.now ?? Date.now()) - success > (input.freshnessSlaMinutes ?? bootstrapPolicyFor('gmail', 'gmail:primary')!.freshnessSlaMinutes) * 60_000) return 'stale'
  return 'current'
}

export function googleConnectionHealthLabel(health: GoogleConnectionHealth, zh: boolean) {
  const labels: Record<GoogleConnectionHealth, [string, string]> = {
    unverified: ['状态待核对', 'Status unverified'],
    reconnect_required: ['需要重新连接 Google', 'Reconnect Google required'],
    configuration_error: ['授权配置需要维护', 'Authorization configuration needs attention'],
    retrying: ['最近检查失败 · 等待重试', 'Latest check failed · Retry pending'],
    disabled: ['未启用', 'Disabled'],
    waiting: ['等待首次完成', 'Waiting for first completed check'],
    stale: ['完成记录已过期', 'Completed check is stale'],
    current: ['最近检查已完成', 'Recent check completed'],
  }
  return labels[health][zh ? 0 : 1]
}
