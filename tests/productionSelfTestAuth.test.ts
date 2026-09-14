import { describe, expect, it, vi } from 'vitest'
import { resolveProductionSelfTestAccessToken } from '../gateway/productionSelfTestAuth.js'

describe('production self-test auth', () => {
  it('prefers an explicitly supplied access token without signing in', async () => {
    const fetchImpl = vi.fn()
    const token = await resolveProductionSelfTestAccessToken({
      accessToken: ' explicit-token ',
      email: 'test@example.com',
      password: 'password',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(token).toBe('explicit-token')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('mints a short-lived access token from a dedicated Supabase test identity', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: 'ephemeral-token' })) as unknown as typeof fetch
    const token = await resolveProductionSelfTestAccessToken({
      email: 'test@example.com',
      password: 'password',
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: 'public-key',
      fetchImpl,
    })
    expect(token).toBe('ephemeral-token')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = (fetchImpl as any).mock.calls[0]
    expect(url).toBe('https://example.supabase.co/auth/v1/token?grant_type=password')
    expect(init.headers.apikey).toBe('public-key')
    expect(JSON.parse(init.body)).toEqual({ email: 'test@example.com', password: 'password' })
  })

  it('fails closed when only one dedicated test credential is supplied', async () => {
    await expect(resolveProductionSelfTestAccessToken({ email: 'test@example.com' }))
      .rejects.toThrow('requires both email and password')
  })

  it('fails closed when the dedicated test identity cannot sign in', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 400 })) as unknown as typeof fetch
    await expect(resolveProductionSelfTestAccessToken({
      email: 'test@example.com',
      password: 'wrong',
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: 'public-key',
      fetchImpl,
    })).rejects.toThrow('HTTP 400')
  })
})
