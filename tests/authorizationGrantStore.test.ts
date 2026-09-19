import { describe, expect, it, vi } from 'vitest'
import { createAuthorizationGrantStore, grantAllows } from '../gateway/authorizationGrantStore.js'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

describe('delegated authorization grant store', () => {
  it('returns only exact active grants for the validated user and client', async () => {
    const fetchImpl = vi.fn(async () => json([
      {
        user_id: 'user-a',
        client_id: 'client-a',
        source_id: 'gmail:primary',
        capability: 'ingest_gmail_run',
      },
      {
        user_id: 'user-a',
        client_id: 'other-client',
        source_id: 'monitor:urgent-campus',
        capability: 'ingest_discovery_run',
      },
    ])) as unknown as typeof fetch
    const store = createAuthorizationGrantStore({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      fetchImpl,
    })

    const grants = await store.listActiveForClient('user-a', 'client-a', 'user-token')
    expect(grants).toEqual([{
      userId: 'user-a',
      clientId: 'client-a',
      sourceId: 'gmail:primary',
      capability: 'ingest_gmail_run',
    }])
    expect(grantAllows(grants, 'ingest_gmail_run', 'gmail:primary')).toBe(true)
    expect(grantAllows(grants, 'ingest_gmail_run', 'gmail:secondary')).toBe(false)
    expect(grantAllows(grants, 'ingest_discovery_run', 'gmail:primary')).toBe(false)
  })
})
