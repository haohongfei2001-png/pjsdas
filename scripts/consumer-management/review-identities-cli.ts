import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { PJSDAS_SUPABASE_URL } from '../../gateway/supabaseProject.js'
import { banReviewIdentities, encryptReviewPacket, newReviewPacket, provisionReviewIdentities, reviewProject, validateManifest, type ReviewPacket } from './review-identities.js'

async function main() {
  if (process.argv.includes('--plan')) {
    console.log('Two new synthetic identities; original project only; encrypted recovery before creation; no audience, OAuth, business grant, policy or deployment change. Dedicated cleanup bans only exact matching marked identities. No network or write.')
    return
  }
  if (process.argv.includes('--prepare')) {
    if (process.env.TA_REVIEW_MODE !== 'provision') throw new Error('REVIEW_MODE_INVALID')
    const packet = newReviewPacket({ expectedSha: process.env.TA_REVIEW_EXPECTED_SHA ?? '', clientId: process.env.TA_REVIEW_VERIFIED_CLIENT_ID ?? '', expiresAt: process.env.TA_REVIEW_EXPIRES_AT ?? '' })
    const encrypted = encryptReviewPacket(packet, Buffer.from(process.env.TA_REVIEW_RECIPIENT_PUBLIC_KEY_BASE64 ?? '', 'base64').toString('utf8'))
    const output = process.env.TA_REVIEW_OUTPUT_DIR, privatePath = process.env.TA_REVIEW_PRIVATE_PACKET
    if (!output || !privatePath || dirname(privatePath) === output || privatePath.startsWith(output + '/')) throw new Error('REVIEW_PRIVATE_OUTPUT_INVALID')
    await mkdir(output, { recursive: true, mode: 0o700 })
    await mkdir(dirname(privatePath), { recursive: true, mode: 0o700 })
    await writeFile(privatePath, JSON.stringify(packet), { mode: 0o600, flag: 'wx' })
    await writeFile(join(output, 'recovery.encrypted.json'), JSON.stringify(encrypted), { mode: 0o600, flag: 'wx' })
    await writeFile(join(output, 'identity-manifest.json'), JSON.stringify(packet.manifest), { mode: 0o600, flag: 'wx' })
    console.log('Encrypted recovery prepared; no network or account creation. Upload recovery before executing.')
    return
  }
  if (!process.argv.includes('--execute')) throw new Error('Use --plan, --prepare or --execute')
  if (PJSDAS_SUPABASE_URL !== `https://${reviewProject}.supabase.co`) throw new Error('REVIEW_PROJECT_INVALID')
  const key = process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('REVIEW_EXISTING_CREDENTIAL_MISSING')
  const admin = createClient(PJSDAS_SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000), redirect: 'error' }) } })
  if (process.env.TA_REVIEW_MODE === 'ban') {
    const manifest = validateManifest(JSON.parse(process.env.TA_REVIEW_MANIFEST ?? ''))
    const results = await banReviewIdentities(admin, manifest)
    console.log(JSON.stringify({ mode: 'ban', results, audienceAndConsentCleanupRequiresSeparateReadback: true }))
    if (results.some(r => r.result === 'failed')) throw new Error('REVIEW_BAN_INCOMPLETE')
    return
  }
  if (process.env.TA_REVIEW_MODE !== 'provision') throw new Error('REVIEW_MODE_INVALID')
  const privatePath = process.env.TA_REVIEW_PRIVATE_PACKET
  if (!privatePath || !/^[1-9][0-9]*$/.test(process.env.TA_REVIEW_RECOVERY_ARTIFACT_ID ?? '')) throw new Error('REVIEW_DURABLE_RECOVERY_MISSING')
  const stat = await lstat(privatePath)
  if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error('REVIEW_PRIVATE_PACKET_UNSAFE')
  const packet: ReviewPacket = JSON.parse(await readFile(privatePath, 'utf8'))
  validateManifest(packet.manifest, Date.now())
  if (packet.manifest.expectedSha !== process.env.TA_REVIEW_EXPECTED_SHA || packet.manifest.clientId !== process.env.TA_REVIEW_VERIFIED_CLIENT_ID || packet.manifest.expiresAt !== process.env.TA_REVIEW_EXPIRES_AT) throw new Error('REVIEW_PREPARED_SCOPE_CHANGED')
  const health = await fetch('https://todayaction.com/api/health', { redirect: 'error', signal: AbortSignal.timeout(12000) })
  const body = await health.json()
  if (!health.ok || body.release?.commitSha !== packet.manifest.expectedSha || body.workspaceAuthority !== 'transactional' || body.topology?.audienceMode !== 'allowlist') throw new Error('REVIEW_DEPLOYMENT_MISMATCH')
  const result = await provisionReviewIdentities(admin, packet, async () => {})
  console.log(JSON.stringify({ ...result, credentials: 'encrypted-artifact-only', expiresAt: packet.manifest.expiresAt }))
}
main().catch(() => { console.error('Controlled review identity operation stopped. Inspect the encrypted recovery manifest; no automatic replay. Credentials and provider details withheld.'); process.exitCode = 1 })
