/** Dedicated synthetic identities only. Never changes audience, OAuth or business grants. */
import { createCipheriv, createPublicKey, publicEncrypt, randomBytes, randomUUID, constants } from 'node:crypto'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { CONSUMER_REVIEW_NOTE_PREFIX } from '../../gateway/consumerReviewLease.js'

export const reviewProject = 'yyrzwpoxlxpafdlbkdtg'
export const reviewPurpose = 'todayaction-consumer-v7-review'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const anyUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export interface ReviewManifest {
  project: string; origin: string; expectedSha: string; clientId: string; leaseId: string; expiresAt: string
  identities: Array<{ label: 'a' | 'b'; id: string; email: string }>
}
export interface ReviewPacket { manifest: ReviewManifest; passwords: Record<'a' | 'b', string> }

export function reviewAudienceNote(manifest: ReviewManifest) {
  validateManifest(manifest)
  return `${CONSUMER_REVIEW_NOTE_PREFIX}${manifest.expiresAt}|${manifest.leaseId}`
}

export function validateManifest(value: ReviewManifest, now?: number) {
  if (value.project !== reviewProject || value.origin !== 'https://todayaction.com'
    || !/^[0-9a-f]{40}$/.test(value.expectedSha) || !anyUuid.test(value.clientId) || !uuid.test(value.leaseId)
    || !Array.isArray(value.identities) || value.identities.length !== 2
    || value.identities.map(i => i.label).join(',') !== 'a,b'
    || new Set(value.identities.map(i => i.id)).size !== 2
    || value.identities.some(i => !uuid.test(i.id) || i.email !== `ta-consumer-review-${i.label}-${i.id}@example.invalid`)) {
    throw new Error('REVIEW_SCOPE_INVALID')
  }
  const expires = Date.parse(value.expiresAt)
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== value.expiresAt
    || (now !== undefined && (expires <= now || expires - now > 24 * 60 * 60 * 1000))) throw new Error('REVIEW_EXPIRY_INVALID')
  return value
}

export function newReviewPacket(input: Pick<ReviewManifest, 'expectedSha' | 'clientId' | 'expiresAt'>, now = Date.now()): ReviewPacket {
  const identities = (['a', 'b'] as const).map(label => {
    const id = randomUUID()
    return { label, id, email: `ta-consumer-review-${label}-${id}@example.invalid` }
  })
  const manifest = validateManifest({ ...input, project: reviewProject, origin: 'https://todayaction.com', leaseId: randomUUID(), identities }, now)
  return { manifest, passwords: { a: randomBytes(48).toString('base64url'), b: randomBytes(48).toString('base64url') } }
}

export function encryptReviewPacket(packet: ReviewPacket, recipientPem: string) {
  if (!recipientPem.startsWith('-----BEGIN PUBLIC KEY-----\n') || recipientPem.includes('PRIVATE KEY') || recipientPem.length > 10000) throw new Error('REVIEW_RECIPIENT_INVALID')
  const recipient = createPublicKey(recipientPem)
  if (recipient.asymmetricKeyType !== 'rsa' || (recipient.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) throw new Error('REVIEW_RECIPIENT_INVALID')
  const key = randomBytes(32), nonce = randomBytes(12)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const aad = Buffer.from(`todayaction-review:${reviewProject}:${packet.manifest.leaseId}`)
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(packet), 'utf8'), cipher.final()])
    return { format: 'ta-review-rsa-oaep-sha256-aes256gcm-v1', aad: aad.toString('base64'), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), encryptedKey: publicEncrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'), ciphertext: ciphertext.toString('base64') }
  } finally { key.fill(0) }
}

function matches(user: User | null, manifest: ReviewManifest, identity: ReviewManifest['identities'][number]) {
  const m = user?.app_metadata
  return user?.id === identity.id && user.email === identity.email && user.role === 'authenticated'
    && m?.purpose === reviewPurpose && m.review_project === reviewProject && m.review_lease === manifest.leaseId
    && m.review_client === manifest.clientId && m.review_expires_at === manifest.expiresAt && m.review_label === identity.label
}

export async function banReviewIdentities(admin: SupabaseClient, manifest: ReviewManifest) {
  validateManifest(manifest) // Cleanup remains available after expiry.
  const results: Array<{ label: string; result: 'absent' | 'banned' | 'failed' }> = []
  for (const identity of manifest.identities) {
    try {
      const before = await admin.auth.admin.getUserById(identity.id)
      if (before.error?.status === 404) { results.push({ label: identity.label, result: 'absent' }); continue }
      if (before.error || !matches(before.data.user, manifest, identity)) throw new Error('REVIEW_IDENTITY_MISMATCH')
      const changed = await admin.auth.admin.updateUserById(identity.id, { ban_duration: '876000h' })
      if (changed.error) throw new Error('REVIEW_BAN_FAILED')
      const after = await admin.auth.admin.getUserById(identity.id)
      const bannedUntil = (after.data.user as (User & { banned_until?: string }) | null)?.banned_until
      if (after.error || !matches(after.data.user, manifest, identity) || !bannedUntil || Date.parse(bannedUntil) <= Date.now()) throw new Error('REVIEW_BAN_UNCONFIRMED')
      results.push({ label: identity.label, result: 'banned' })
    } catch { results.push({ label: identity.label, result: 'failed' }) }
  }
  return results
}

export async function provisionReviewIdentities(admin: SupabaseClient, packet: ReviewPacket, persistEncryptedRecovery: () => Promise<void>) {
  validateManifest(packet.manifest, Date.now())
  if (!['a', 'b'].every(label => /^[A-Za-z0-9_-]{64}$/.test(packet.passwords[label as 'a' | 'b']))) throw new Error('REVIEW_PASSWORD_INVALID')
  // A new workflow run must not silently replace an uncertain or retired pair.
  // Inspect metadata in the existing cloud admin context; never export the list.
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('REVIEW_IDENTITY_INVENTORY_INCOMPLETE')
    const inventory = await admin.auth.admin.listUsers({ page, perPage: 100 })
    if (inventory.error || !Array.isArray(inventory.data.users)) throw new Error('REVIEW_IDENTITY_INVENTORY_INCOMPLETE')
    if (inventory.data.users.some((user: User) => user.app_metadata?.purpose === reviewPurpose)) throw new Error('REVIEW_PAIR_ALREADY_EXISTS_USE_RECOVERY')
    if (inventory.data.users.length < 100) break
  }
  // Recovery must already exist before an API call can have an uncertain result.
  await persistEncryptedRecovery()
  try {
    for (const identity of packet.manifest.identities) {
      validateManifest(packet.manifest, Date.now())
      const created = await admin.auth.admin.createUser({ id: identity.id, email: identity.email, password: packet.passwords[identity.label], email_confirm: true,
        app_metadata: { purpose: reviewPurpose, review_project: reviewProject, review_lease: packet.manifest.leaseId, review_client: packet.manifest.clientId, review_expires_at: packet.manifest.expiresAt, review_label: identity.label } })
      if (created.error || !matches(created.data.user, packet.manifest, identity)) throw new Error('REVIEW_CREATE_UNCONFIRMED')
      const readback = await admin.auth.admin.getUserById(identity.id)
      if (readback.error || !matches(readback.data.user, packet.manifest, identity)) throw new Error('REVIEW_CREATE_UNCONFIRMED')
    }
    validateManifest(packet.manifest, Date.now())
    return { created: 2, audienceGranted: false, businessGranted: false }
  } catch {
    const cleanup = await banReviewIdentities(admin, packet.manifest)
    throw new Error(cleanup.every(r => r.result !== 'failed') ? 'REVIEW_PROVISION_FAILED_IDENTITIES_DISABLED' : 'REVIEW_PROVISION_FAILED_CLEANUP_REQUIRED')
  }
}
