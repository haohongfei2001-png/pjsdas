import { createClient } from '@supabase/supabase-js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../../gateway/supabaseProject.js'

// PJSDAS account identity is intentionally durable across page refreshes and
// browser restarts. Workspace data remains local-first in IndexedDB; this only
// persists the Supabase Auth session needed to identify the account.
const storage = typeof window !== 'undefined' ? window.localStorage : undefined

export const pjsdasSupabase = createClient(
  PJSDAS_SUPABASE_URL,
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
      ...(storage ? { storage } : {}),
    },
  },
)
