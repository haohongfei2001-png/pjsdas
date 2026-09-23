/** A short-lived, synthetic-only production identity for the CGR-02 command canary. */
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { PJSDAS_SUPABASE_PUBLISHABLE_KEY, PJSDAS_SUPABASE_URL } from '../gateway/supabaseProject.js'

const requireEnv = (key: string) => {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`Missing ${key}; no test account was created.`)
  return value
}

async function preflight() {
  const origin = new URL(requireEnv('PJSDAS_CGR02_CANARY_ORIGIN'))
  const expectedSha = requireEnv('PJSDAS_EXPECTED_COMMIT_SHA').toLowerCase()
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || !/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error('Invalid HTTPS origin or exact SHA; no test account was created.')
  }
  const response = await fetch(`${origin.origin}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(12_000) })
  const health = await response.json().catch(() => undefined) as { release?: { commitSha?: string }; workspaceAuthority?: string } | undefined
  if (!response.ok || health?.release?.commitSha !== expectedSha || health.workspaceAuthority !== 'transactional') {
    throw new Error('Production is not serving the exact integrated transactional SHA; no test account was created.')
  }
}

async function run() {
  if (process.argv.includes('--plan')) {
    console.log('CGR-02 identity plan valid: exact deployed SHA -> create one random synthetic account -> temporary beta grant -> two separate sessions -> command canary -> revoke grant -> sign out -> delete only the created account. No network or write occurred.')
    return
  }
  if (!process.argv.includes('--execute')) throw new Error('Use --plan or --execute; no network or write occurred.')
  await preflight()
  const serviceRoleKey = requireEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY')
  const admin = createClient(PJSDAS_SUPABASE_URL, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const email = `cgr02-canary-${randomUUID()}@example.invalid`
  const password = randomBytes(48).toString('base64url')
  let userId: string | undefined
  let granted = false
  let clientA: ReturnType<typeof createClient> | undefined
  let clientB: ReturnType<typeof createClient> | undefined
  let signedInA = false
  let canaryStarted = false
  let canaryPassed = false
  let failure: unknown
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true,
      app_metadata: { purpose: 'pjsdas-cgr02-synthetic-canary' } })
    if (created.error || !created.data.user?.id || created.data.user.email !== email) {
      throw new Error('Synthetic test account creation failed.')
    }
    userId = created.data.user.id
    const grant = await admin.from('pjsdas_access_grants').insert({ user_id: userId, email,
      role: 'beta', note: 'CGR-02 synthetic command canary; temporary' })
    if (grant.error) throw new Error('Temporary synthetic audience grant failed.')
    granted = true

    const options = { auth: { persistSession: false, autoRefreshToken: false } }
    clientA = createClient(PJSDAS_SUPABASE_URL, PJSDAS_SUPABASE_PUBLISHABLE_KEY, options)
    clientB = createClient(PJSDAS_SUPABASE_URL, PJSDAS_SUPABASE_PUBLISHABLE_KEY, options)
    const sessionA = await clientA.auth.signInWithPassword({ email, password })
    const sessionB = await clientB.auth.signInWithPassword({ email, password })
    const tokenA = sessionA.data.session?.access_token
    const tokenB = sessionB.data.session?.access_token
    signedInA = Boolean(tokenA)
    if (sessionA.error || sessionB.error || !tokenA || !tokenB || tokenA === tokenB
      || sessionA.data.user?.id !== userId || sessionB.data.user?.id !== userId) {
      throw new Error('Two distinct authenticated synthetic sessions were not established.')
    }
    process.env.PJSDAS_CGR02_CANARY_ACCESS_TOKEN_A = tokenA
    process.env.PJSDAS_CGR02_CANARY_ACCESS_TOKEN_B = tokenB
    canaryStarted = true
    await import('./cgr02-production-canary.js')
    canaryPassed = true
  } catch (error) {
    failure = error
  } finally {
    delete process.env.PJSDAS_CGR02_CANARY_ACCESS_TOKEN_A
    delete process.env.PJSDAS_CGR02_CANARY_ACCESS_TOKEN_B
    if (userId) {
      const cleanupErrors: string[] = []
      let grantRevoked = !granted
      // The allowlist is the server-side access boundary; revoke it before
      // signing out because already issued access JWTs live until expiry.
      if (granted) {
        const revoked = await admin.from('pjsdas_access_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId)
        if (revoked.error) cleanupErrors.push('audience grant revocation')
        else grantRevoked = true
      }
      if (clientA && signedInA) {
        const result = await clientA.auth.signOut({ scope: 'global' })
        if (result.error) cleanupErrors.push('session revocation')
      }
      // A failed command canary may need its synthetic workspace retained for
      // receipt-based recovery. Its audience access is revoked meanwhile.
      const preserveForRecovery = canaryStarted && !canaryPassed && grantRevoked
      if (!preserveForRecovery) {
        const deleted = await admin.auth.admin.deleteUser(userId)
        if (deleted.error) cleanupErrors.push('synthetic account deletion')
      }
      if (cleanupErrors.length) {
        throw new Error(`Synthetic identity cleanup incomplete (${cleanupErrors.join(', ')}); created user ID ${userId} requires controlled recovery.`)
      }
      if (preserveForRecovery) console.log(`CGR-02 failed canary account access revoked; user ID ${userId} retained for receipt recovery.`)
      else console.log('CGR-02 synthetic account and temporary audience grant removed; sessions revoked.')
    }
  }
  if (failure) throw failure
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'CGR-02 synthetic identity canary failed.')
  process.exitCode = 1
})
