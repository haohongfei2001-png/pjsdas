import * as z from 'zod/v4'
import {
  OwnerConsentError,
  type OwnerConsentDecision,
} from './ownerManagementConsentClient.js'
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const prefix = 'todayaction-owner-consent-pending-v2:'
const schema = z
  .object({
    requestId: z.uuid(),
    expectedAccountId: z.uuid(),
    clientId: z.uuid(),
    decision: z.enum(['approve', 'revoke']),
    consentVersion: z.literal(2),
    consentTextHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedGrant: z
      .object({
        id: z.uuid(),
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .nullable(),
    confirmed: z.literal(true),
  })
  .strict()
function storage(given?: PendingStorage) {
  if (given) return given
  try {
    return window.sessionStorage
  } catch {
    throw new OwnerConsentError(
      'PENDING_STORAGE_UNAVAILABLE',
      '无法保存本标签页的请求编号，请不要再次授权。',
    )
  }
}
export function readPendingOwnerConsent(
  accountId: string,
  given?: PendingStorage,
): OwnerConsentDecision | null {
  try {
    const raw = storage(given).getItem(prefix + accountId)
    if (!raw) return null
    if (raw.length > 8192) throw new Error('oversized')
    const parsed = schema.parse(JSON.parse(raw))
    if (parsed.expectedAccountId !== accountId)
      throw new Error('account mismatch')
    return Object.freeze({
      ...parsed,
      expectedGrant: parsed.expectedGrant
        ? Object.freeze(parsed.expectedGrant)
        : null,
    })
  } catch {
    throw new OwnerConsentError(
      'PENDING_STATE_INVALID',
      '无法核对本标签页之前的未确认请求，请先核对当前授权状态。',
    )
  }
}
/** Only decision metadata, never session/access/refresh tokens. Saved before POST. */
export function savePendingOwnerConsent(
  body: OwnerConsentDecision,
  given?: PendingStorage,
) {
  try {
    const parsed = schema.parse(body),
      target = storage(given),
      existing = readPendingOwnerConsent(parsed.expectedAccountId, target)
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed))
      throw new OwnerConsentError(
        'PENDING_CONFLICT',
        '本标签页还有另一个未确认请求。请重新读取，不能覆盖它的请求编号。',
      )
    target.setItem(prefix + parsed.expectedAccountId, JSON.stringify(parsed))
  } catch (caught) {
    if (caught instanceof OwnerConsentError) throw caught
    throw new OwnerConsentError(
      'PENDING_STORAGE_UNAVAILABLE',
      '无法保存请求编号，尚未发送本次授权操作。',
    )
  }
}
/** A late receipt from an older document must never remove a newer pending intent. */
export function clearPendingOwnerConsent(
  body: OwnerConsentDecision,
  given?: PendingStorage,
) {
  try {
    const parsed = schema.parse(body),
      target = storage(given),
      existing = readPendingOwnerConsent(parsed.expectedAccountId, target)
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed))
      return false
    target.removeItem(prefix + parsed.expectedAccountId)
    return true
  } catch {
    return false
  }
}
