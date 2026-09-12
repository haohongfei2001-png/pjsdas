import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const supabaseClient = readFileSync(new URL('../src/aiAccess/supabaseClient.ts', import.meta.url), 'utf8')
const cloudClient = readFileSync(new URL('../src/cloud/cloudClient.ts', import.meta.url), 'utf8')
const cloudContext = readFileSync(new URL('../src/cloud/CloudContext.tsx', import.meta.url), 'utf8')
const cloudRepository = readFileSync(new URL('../src/cloud/cloudRepository.ts', import.meta.url), 'utf8')
const aiAccess = readFileSync(new URL('../src/aiAccess/AiAccessContext.tsx', import.meta.url), 'utf8')
const accessApi = readFileSync(new URL('../api/google-access-token.ts', import.meta.url), 'utf8')

describe('v1.8.1 stable account and sync session', () => {
  it('persists the PJSDAS Supabase account beyond the current tab', () => {
    expect(supabaseClient).toContain('window.localStorage')
    expect(supabaseClient).not.toContain('window.sessionStorage')
    expect(supabaseClient).toContain('persistSession: true')
    expect(supabaseClient).toContain('autoRefreshToken: true')
  })

  it('uses Supabase Google OAuth for durable account identity instead of the old in-memory GIS token model', () => {
    expect(cloudClient).toContain('signInWithOAuth')
    expect(cloudClient).toContain("access_type: 'offline'")
    expect(cloudClient).toContain("prompt: 'consent'")
    expect(cloudClient).not.toContain('accounts.google.com/gsi/client')
    expect(cloudContext).toContain('subscribeCloudSession')
    expect(cloudContext).toContain('completePendingGoogleLink')
  })

  it('restores short-lived Drive access through the authenticated backend while keeping Drive data direct-to-Google', () => {
    expect(cloudClient).toContain('/api/google-access-token')
    expect(cloudRepository).toContain('await getCloudAccessToken()')
    expect(cloudRepository).toContain('https://www.googleapis.com/drive/v3')
    expect(accessApi).toContain('createGoogleAccessTokenHandler')
  })

  it('does not destroy the stable account after AI access linking', () => {
    expect(aiAccess).not.toContain("auth.signOut({ scope: 'local' })")
    expect(aiAccess).toContain('same durable Supabase session')
  })
})
