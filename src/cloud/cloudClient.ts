import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { cloudRedirectUrl, readCloudConfig } from './cloudConfig'

let singleton: SupabaseClient | null | undefined

export function getCloudClient() {
  if (singleton !== undefined) return singleton
  const config = readCloudConfig()
  if (!config) {
    singleton = null
    return null
  }
  singleton = createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  return singleton
}

export async function getCloudSession(): Promise<Session | null> {
  const client = getCloudClient()
  if (!client) return null
  const { data, error } = await client.auth.getSession()
  if (error) throw error
  return data.session
}

export async function signInWithGoogle() {
  const client = getCloudClient()
  if (!client) throw new Error('云端尚未配置。')
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: cloudRedirectUrl() },
  })
  if (error) throw error
}

export async function signOutCloud() {
  const client = getCloudClient()
  if (!client) return
  const { error } = await client.auth.signOut()
  if (error) throw error
}
