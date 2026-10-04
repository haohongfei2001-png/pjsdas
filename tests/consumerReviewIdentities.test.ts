import { beforeAll, expect, it, vi } from 'vitest'
import { createDecipheriv, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { banReviewIdentities, encryptReviewPacket, newReviewPacket, provisionReviewIdentities, reviewPurpose, validateManifest } from '../scripts/consumer-management/review-identities.js'

const input = () => ({ expectedSha: 'a'.repeat(40), clientId: '00000000-0000-4000-8000-000000000081', expiresAt: new Date(Date.now() + 3600000).toISOString() })
function fixture() {
  const users = new Map<string, any>(), calls: string[] = []
  let uncertainSecond = false, foreignSecond = false
  const api = {
    listUsers: vi.fn(async () => ({ data: { users: [...users.values()] }, error: null })),
    createUser: vi.fn(async (value: any) => {
      calls.push('create'); const user = { id: value.id, email: value.email, role: 'authenticated', app_metadata: value.app_metadata }
      users.set(value.id, user)
      if (calls.filter(v => v === 'create').length === 2) {
        if (foreignSecond) user.app_metadata = { purpose: 'unrelated-user' }
        if (uncertainSecond) throw new Error('Provider response with a secret must never escape')
      }
      return { data: { user }, error: null }
    }),
    getUserById: vi.fn(async (id: string) => ({ data: { user: users.get(id) ?? null }, error: users.has(id) ? null : { status: 404 } })),
    updateUserById: vi.fn(async (id: string, value: any) => {
      calls.push('ban'); expect(value).toEqual({ ban_duration: '876000h' })
      users.get(id).banned_until = new Date(Date.now() + 86400000).toISOString()
      return { data: { user: users.get(id) }, error: null }
    }),
  }
  return { admin: { auth: { admin: api } } as unknown as SupabaseClient, api, users, calls, failSecond: () => { uncertainSecond = true }, collideSecond: () => { foreignSecond = true } }
}

it('creates exactly two fresh marked identities only after recovery exists; no data or grant API is available', async () => {
  const f = fixture(), packet = newReviewPacket(input())
  const result = await provisionReviewIdentities(f.admin, packet, async () => { f.calls.push('recovery') })
  expect(f.calls).toEqual(['recovery', 'create', 'create'])
  expect(result).toEqual({ created: 2, audienceGranted: false, businessGranted: false })
  expect(new Set(packet.manifest.identities.map(i => i.id)).size).toBe(2)
  for (const i of packet.manifest.identities) expect(f.users.get(i.id).app_metadata).toMatchObject({ purpose: reviewPurpose, review_lease: packet.manifest.leaseId })
  const again = newReviewPacket(input())
  await expect(provisionReviewIdentities(f.admin, again, async () => { throw Error('Must not persist a replacement') })).rejects.toThrow('REVIEW_PAIR_ALREADY_EXISTS_USE_RECOVERY')
  expect(f.api.createUser).toHaveBeenCalledTimes(2)
})

it('does not create any identity if encrypted recovery persistence fails', async () => {
  const f = fixture()
  await expect(provisionReviewIdentities(f.admin, newReviewPacket(input()), async () => { throw Error('Disk unavailable') })).rejects.toThrow('Disk unavailable')
  expect(f.api.createUser).not.toHaveBeenCalled(); expect(f.api.updateUserById).not.toHaveBeenCalled()
})

it('handles a response lost after the second creation by readback and banning both, without retrying creation', async () => {
  const f = fixture(); f.failSecond()
  await expect(provisionReviewIdentities(f.admin, newReviewPacket(input()), async () => {})).rejects.toThrow('REVIEW_PROVISION_FAILED_IDENTITIES_DISABLED')
  expect(f.calls).toEqual(['create', 'create', 'ban', 'ban'])
  expect([...f.users.values()].every(u => u.banned_until)).toBe(true)
})

it('never changes a foreign identity on a mismatched create result; still disables the matching created identity', async () => {
  const f = fixture(), packet = newReviewPacket(input()); f.collideSecond()
  await expect(provisionReviewIdentities(f.admin, packet, async () => {})).rejects.toThrow('REVIEW_PROVISION_FAILED_CLEANUP_REQUIRED')
  expect(f.api.updateUserById.mock.calls.map(c => c[0])).toEqual([packet.manifest.identities[0].id])
})

it('allows cleanup after expiry and checks exact metadata and ban readback', async () => {
  const f = fixture(), packet = newReviewPacket(input())
  await provisionReviewIdentities(f.admin, packet, async () => {})
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 7200000)
  try { expect(await banReviewIdentities(f.admin, packet.manifest)).toEqual([{ label: 'a', result: 'banned' }, { label: 'b', result: 'banned' }]) }
  finally { vi.useRealTimers() }
})

it.each(['project', 'origin', 'clientId', 'expectedSha', 'leaseId'] as const)('rejects an invalid %s before admin calls', async field => {
  const f = fixture(), packet = newReviewPacket(input()); packet.manifest[field] = 'not-approved'
  await expect(provisionReviewIdentities(f.admin, packet, async () => {})).rejects.toThrow('REVIEW_SCOPE_INVALID')
  expect(f.api.listUsers).not.toHaveBeenCalled()
})

it('rejects oversized leases, duplicate IDs, non-synthetic email and weak passwords', async () => {
  expect(() => newReviewPacket({ ...input(), expiresAt: new Date(Date.now() + 25 * 3600000).toISOString() })).toThrow('REVIEW_EXPIRY_INVALID')
  const packet = newReviewPacket(input()), other = structuredClone(packet.manifest)
  other.identities[1] = { ...other.identities[0], label: 'b' }; expect(() => validateManifest(other)).toThrow('REVIEW_SCOPE_INVALID')
  other.identities[0].email = 'personal@example.com'; expect(() => validateManifest(other)).toThrow('REVIEW_SCOPE_INVALID')
  packet.passwords.a = 'weak'; const f = fixture()
  await expect(provisionReviewIdentities(f.admin, packet, async () => {})).rejects.toThrow('REVIEW_PASSWORD_INVALID'); expect(f.api.listUsers).not.toHaveBeenCalled()
})

let pair: ReturnType<typeof generateKeyPairSync>
beforeAll(() => { pair = generateKeyPairSync('rsa', { modulusLength: 3072 }) })
it('encrypted recovery contains no password text and decrypts only with the recipient key; tampering fails', () => {
  const packet = newReviewPacket(input())
  const sealed = encryptReviewPacket(packet, pair.publicKey.export({ type: 'spki', format: 'pem' }).toString())
  for (const password of Object.values(packet.passwords)) expect(JSON.stringify(sealed)).not.toContain(password)
  const key = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(sealed.encryptedKey, 'base64'))
  const decrypt = (ciphertext: Buffer) => {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64'))
    cipher.setAAD(Buffer.from(sealed.aad, 'base64')); cipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    return JSON.parse(Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8'))
  }
  expect(decrypt(Buffer.from(sealed.ciphertext, 'base64'))).toEqual(packet)
  const modified = Buffer.from(sealed.ciphertext, 'base64'); modified[0] ^= 1
  expect(() => decrypt(modified)).toThrow()
  const weak = generateKeyPairSync('rsa', { modulusLength: 2048 })
  expect(() => encryptReviewPacket(packet, weak.publicKey.export({ type: 'spki', format: 'pem' }).toString())).toThrow('REVIEW_RECIPIENT_INVALID')
  expect(() => encryptReviewPacket(packet, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())).toThrow('REVIEW_RECIPIENT_INVALID')
})

it('the actual prepare command keeps plaintext outside the upload directory, without any admin credential', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-review-prepare-')), output = join(root, 'encrypted'), privatePath = join(root, 'private', 'packet.json')
  const env = { ...process.env, PJSDAS_SUPABASE_SERVICE_ROLE_KEY: '', TA_REVIEW_MODE: 'provision', TA_REVIEW_EXPECTED_SHA: input().expectedSha,
    TA_REVIEW_VERIFIED_CLIENT_ID: input().clientId, TA_REVIEW_EXPIRES_AT: input().expiresAt, TA_REVIEW_RECIPIENT_PUBLIC_KEY_BASE64: Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'), TA_REVIEW_OUTPUT_DIR: output, TA_REVIEW_PRIVATE_PACKET: privatePath }
  try {
    const log = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/consumer-management/review-identities-cli.ts', '--prepare'], { env, encoding: 'utf8' })
    expect(readdirSync(output).sort()).toEqual(['identity-manifest.json', 'recovery.encrypted.json'])
    expect(statSync(privatePath).mode & 0o777).toBe(0o600)
    const packet = JSON.parse(readFileSync(privatePath, 'utf8'))
    const uploaded = readdirSync(output).map(name => readFileSync(join(output, name), 'utf8')).join('')
    for (const password of Object.values(packet.passwords)) { expect(uploaded).not.toContain(password); expect(log).not.toContain(password) }
    expect(log).toContain('no network or account creation')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
