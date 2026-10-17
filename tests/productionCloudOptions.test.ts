import { afterEach, expect, it, vi } from 'vitest'
const client = vi.hoisted(() => ({ create: vi.fn(() => ({ synthetic: true })) }))
vi.mock('@supabase/supabase-js', () => ({ createClient: client.create }))
import { PJSDAS_SUPABASE_URL, PJSDAS_SUPABASE_PUBLISHABLE_KEY } from '../gateway/supabaseProject.js'
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); client.create.mockClear() })
it.each([{ MODE: 'production', VITE_PJSDAS_CLOUD_MODE: '' }, { MODE: 'development', VITE_PJSDAS_CLOUD_MODE: 'live' }])('keeps existing live Auth URL, namespace, persistence and refresh options: %j', async env => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }; vi.stubGlobal('window', { localStorage: storage })
  await import('../src/aiAccess/supabaseClient.js')
  expect(client.create).toHaveBeenCalledWith(PJSDAS_SUPABASE_URL, PJSDAS_SUPABASE_PUBLISHABLE_KEY, {
    auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true, storage },
  })
  expect(client.create.mock.calls[0][2].auth).not.toHaveProperty('storageKey')
  expect(storage.removeItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled()
})
