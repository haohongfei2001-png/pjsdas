import { describe, expect, it, vi } from 'vitest'
import { createAudienceAccessGuard } from '../gateway/audienceAccess.js'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

describe('controlled audience authorization', () => {
  it('preserves current behavior in legacy mode without touching the allowlist store', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const guard = createAudienceAccessGuard({
      supabaseUrl: 'https://example.supabase.co',
      mode: 'legacy',
      fetchImpl,
    })
    await expect(guard({ userId: 'user-a', email: 'a@example.com' })).resolves.toMatchObject({
      allowed: true,
      mode: 'legacy',
      role: 'legacy',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows only an active exact user grant in allowlist mode', async () => {
    const fetchImpl = vi.fn(async () => json([{
      user_id: 'user-a',
      email: 'a@example.com',
      role: 'owner',
    }])) as unknown as typeof fetch
    const guard = createAudienceAccessGuard({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role',
      mode: 'allowlist',
      fetchImpl,
    })
    await expect(guard({ userId: 'user-a', email: 'a@example.com' })).resolves.toMatchObject({
      allowed: true,
      mode: 'allowlist',
      role: 'owner',
    })
  })

  it('fails closed for an authenticated account without a grant', async () => {
    const fetchImpl = vi.fn(async () => json([])) as unknown as typeof fetch
    const guard = createAudienceAccessGuard({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role',
      mode: 'allowlist',
      fetchImpl,
    })
    await expect(guard({ userId: 'user-x', email: 'x@example.com' })).rejects.toMatchObject({
      code: 'AUDIENCE_ACCESS_REQUIRED',
    })
  })
})
