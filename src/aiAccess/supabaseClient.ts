import { createClient } from '@supabase/supabase-js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../../gateway/supabaseProject.js'

const storage = typeof window !== 'undefined' ? window.sessionStorage : undefined

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
