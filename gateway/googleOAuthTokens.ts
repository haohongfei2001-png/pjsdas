import { WorkspaceSourceError } from './workspaceSource.js'

export interface GoogleOAuthClientConfig {
  clientId: string
  clientSecret: string
  fetchImpl?: typeof fetch
  /** Persist a replacement before using its access token. Never discard rotation. */
  onRefreshTokenRotated?: (refreshToken: string) => Promise<void>
  /** Only an explicit invalid_grant is evidence that this credential needs reconnect. */
  onReconnectRequired?: () => Promise<void>
  signal?: AbortSignal
  retryDelayMs?: number
  beforeRefresh?: () => void
}

function unavailable() {
  return new WorkspaceSourceError('GOOGLE_DRIVE_UNAVAILABLE', 'Google authorization service is temporarily unavailable.', true)
}

async function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw unavailable()
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(unavailable()) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** At most two refresh attempts. Transport failures and provider outages must not
 * erase durable authorization or tell users their consent has been revoked. */
export async function refreshGoogleAccessToken(refreshToken: string, config: GoogleOAuthClientConfig) {
  if (!refreshToken) throw new WorkspaceSourceError('GOOGLE_CONNECTION_REQUIRED', 'Google is not connected to TodayAction.', false)
  config.beforeRefresh?.()
  const fetchImpl = config.fetchImpl ?? fetch
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (config.signal?.aborted) throw unavailable()
    let response: Response | undefined
    let data: Record<string, unknown> | undefined
    try {
      response = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
          refresh_token: refreshToken, grant_type: 'refresh_token' }),
        signal: config.signal ? AbortSignal.any([config.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
      })
      const parsed: unknown = await response.json()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
    } catch { /* No provider body or secret may escape into logs/errors. */ }

    // Only a normal OAuth rejection is definitive. Proxy/5xx payloads cannot
    // revoke a binding, even if they happen to contain an invalid_grant string.
    if (response && (response.status === 400 || response.status === 401) && data?.error === 'invalid_grant') {
      await config.onReconnectRequired?.()
      throw new WorkspaceSourceError('GOOGLE_AUTH_EXPIRED', 'Google authorization is no longer valid. Reconnect Google to TodayAction.', false)
    }
    if (response?.ok && typeof data?.access_token === 'string' && data.access_token.trim()) {
      const rotated = typeof data.refresh_token === 'string' ? data.refresh_token.trim() : ''
      if (rotated && rotated !== refreshToken) {
        if (!config.onRefreshTokenRotated) {
          throw new WorkspaceSourceError('GOOGLE_REFRESH_STORAGE_REQUIRED', 'Google returned renewed authorization that could not be saved safely.', true)
        }
        await config.onRefreshTokenRotated(rotated)
      }
      return data.access_token
    }
    if (response && [400, 401, 403].includes(response.status) &&
      ['invalid_client', 'unauthorized_client', 'invalid_request', 'unsupported_grant_type', 'invalid_scope'].includes(String(data?.error))) {
      throw new WorkspaceSourceError('GOOGLE_AUTH_CONFIG_INVALID', 'Google authorization configuration needs administrator attention.', false)
    }
    if (attempt === 0 && !config.signal?.aborted) await delay(Math.max(0, Math.min(config.retryDelayMs ?? 200, 1000)), config.signal)
  }
  throw unavailable()
}
