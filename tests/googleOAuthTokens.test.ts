import { describe, expect, it, vi } from 'vitest'
import { refreshGoogleAccessToken } from '../gateway/googleOAuthTokens.js'
const config = { clientId: 'fictional-client', clientSecret: 'fictional-secret', retryDelayMs: 0 }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('Google refresh lifecycle', () => {
  it.each([429, 500, 503])('retries transient HTTP %s once without reconnect', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ error: 'temporary' }, status)).mockResolvedValueOnce(json({ access_token: 'synthetic-access' }))
    const onReconnectRequired = vi.fn()
    await expect(refreshGoogleAccessToken('synthetic-refresh', { ...config, fetchImpl, onReconnectRequired })).resolves.toBe('synthetic-access')
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(onReconnectRequired).not.toHaveBeenCalled()
  })
  it('does not mistake malformed successful JSON, proxy errors or network errors for revocation', async () => {
    for (const first of [new Response('<html>', { status: 200 }), json({ error: 'invalid_grant' }, 502), new Error('synthetic network')]) {
      const fetchImpl = vi.fn().mockImplementationOnce(async () => { if (first instanceof Error) throw first; return first }).mockResolvedValueOnce(json({ access_token: 'access' }))
      await expect(refreshGoogleAccessToken('refresh', { ...config, fetchImpl })).resolves.toBe('access')
    }
  })
  it('bounds retries and redacts provider error bodies', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'synthetic-sensitive-provider-body' }, 503))
    await expect(refreshGoogleAccessToken('refresh', { ...config, fetchImpl })).rejects.toMatchObject({ code: 'GOOGLE_DRIVE_UNAVAILABLE', retryable: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('persists definitive invalid_grant once, without retry', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'invalid_grant' }, 400)); const onReconnectRequired = vi.fn(async () => {})
    await expect(refreshGoogleAccessToken('refresh', { ...config, fetchImpl, onReconnectRequired })).rejects.toMatchObject({ code: 'GOOGLE_AUTH_EXPIRED', retryable: false })
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(onReconnectRequired).toHaveBeenCalledTimes(1)
  })
  it('separates invalid client configuration from user consent', async () => {
    const onReconnectRequired = vi.fn(); const fetchImpl = vi.fn(async () => json({ error: 'invalid_client' }, 401))
    await expect(refreshGoogleAccessToken('refresh', { ...config, fetchImpl, onReconnectRequired })).rejects.toMatchObject({ code: 'GOOGLE_AUTH_CONFIG_INVALID', retryable: false })
    expect(onReconnectRequired).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('persists rotation before exposing the access token, and propagates persistence failure', async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: 'access', refresh_token: 'replacement' }))
    const onRefreshTokenRotated = vi.fn(async () => {})
    await expect(refreshGoogleAccessToken('refresh', { ...config, fetchImpl, onRefreshTokenRotated })).resolves.toBe('access')
    expect(onRefreshTokenRotated).toHaveBeenCalledWith('replacement')
    onRefreshTokenRotated.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(refreshGoogleAccessToken('refresh', { ...config, fetchImpl, onRefreshTokenRotated })).rejects.toThrow('storage unavailable')
    await expect(refreshGoogleAccessToken('refresh', { ...config, fetchImpl })).rejects.toMatchObject({ code: 'GOOGLE_REFRESH_STORAGE_REQUIRED' })
  })
  it('preserves existing refresh credential when the provider does not rotate', async () => {
    const onRefreshTokenRotated = vi.fn()
    await refreshGoogleAccessToken('refresh', { ...config, fetchImpl: async () => json({ access_token: 'access' }), onRefreshTokenRotated })
    expect(onRefreshTokenRotated).not.toHaveBeenCalled()
  })
  it('does not start a request for an aborted execution', async () => {
    const fetchImpl = vi.fn(); const controller = new AbortController(); controller.abort()
    await expect(refreshGoogleAccessToken('refresh', { ...config, fetchImpl, signal: controller.signal })).rejects.toMatchObject({ retryable: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
