import { createClient } from '@supabase/supabase-js'
import { mockCloudMode, MOCK_AUTH_ORIGIN, MOCK_AUTH_STORAGE_KEY } from '../cloud/runtimeCloudMode.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../../gateway/supabaseProject.js'

// PJSDAS account identity is intentionally durable across page refreshes and
// browser restarts. Workspace data remains local-first in IndexedDB; this only
// persists the Supabase Auth session needed to identify the account.
const storage = typeof window !== 'undefined' ? window.localStorage : undefined
const mock = mockCloudMode()

export const pjsdasSupabase = createClient(
  mock ? MOCK_AUTH_ORIGIN : PJSDAS_SUPABASE_URL,
  mock ? 'todayaction-local-mock-public-key' : PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: !mock,
      ...(mock ? { storageKey: MOCK_AUTH_STORAGE_KEY } : {}),
      ...(storage ? { storage } : {}),
    },
  },
)
