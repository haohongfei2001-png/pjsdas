import { afterEach, expect, it, vi } from 'vitest'
import { MOCK_AUTH_ORIGIN, MOCK_AUTH_STORAGE_KEY, MOCK_BACKEND_ORIGIN } from '../src/cloud/runtimeCloudMode.js'
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules() })
it('the actual isolated Auth client never reads or refreshes an existing production session', async () => {
  vi.stubEnv('MODE', 'development'); vi.stubEnv('VITE_PJSDAS_CLOUD_MODE', '')
  const productionKey = 'sb-yyrzwpoxlxpafdlbkdtg-auth-token'
  const stored = new Map([[productionKey, JSON.stringify({ access_token: 'old-production-shaped-token', refresh_token: 'old-production-shaped-refresh', expires_at: 1, user: { id: 'production-user' } })]])
  const getItem = vi.fn((key: string) => stored.get(key) ?? null)
  const localStorage = { getItem, setItem: vi.fn((key: string, value: string) => stored.set(key, value)), removeItem: vi.fn((key: string) => stored.delete(key)) }
  vi.stubGlobal('window', { localStorage, location: { href: 'http://localhost/' } })
  const fetch = vi.fn(async () => { throw new Error('Unexpected outbound Auth call') }); vi.stubGlobal('fetch', fetch)
  const { pjsdasSupabase } = await import('../src/aiAccess/supabaseClient.js')
  const result = await pjsdasSupabase.auth.getSession()
  expect(result.data.session).toBeNull(); expect(fetch).not.toHaveBeenCalled()
  expect(getItem.mock.calls.some(([key]) => key.startsWith(productionKey))).toBe(false)
  expect(stored.get(productionKey)).toContain('old-production-shaped-refresh')
  expect((pjsdasSupabase as any).supabaseUrl).toBe(MOCK_AUTH_ORIGIN)
  expect((pjsdasSupabase.auth as any).storageKey).toBe(MOCK_AUTH_STORAGE_KEY)
  await pjsdasSupabase.auth.stopAutoRefresh()
})
it('local backend selection ignores ambient real deployment URLs and reports an unconfigured local backend honestly', async () => {
  vi.stubEnv('MODE', 'development'); vi.stubEnv('VITE_PJSDAS_CLOUD_MODE', '')
  vi.stubEnv('VITE_PJSDAS_CANONICAL_API_ORIGIN', 'https://real-project.vercel.app')
  vi.stubEnv('VITE_PJSDAS_BACKEND_ORIGINS', 'https://other-live.example.com')
  const { readBackendOrigins, resolveBackendOrigin } = await import('../src/backendEndpoints.js')
  expect(readBackendOrigins()).toEqual([MOCK_BACKEND_ORIGIN])
  const fetch = vi.fn(async () => new Response('{}', { status: 503 }))
  await expect(resolveBackendOrigin(fetch)).rejects.toThrow('Local mock backend is not configured')
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][0]).toBe(`${MOCK_BACKEND_ORIGIN}/api/health`)
})
