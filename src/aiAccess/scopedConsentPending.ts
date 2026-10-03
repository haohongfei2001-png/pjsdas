import { scopedConsentDecisionSchema } from './scopedConsentContract.js'
import {
  ScopedConsentError,
  type ScopedConsentDecision,
} from './scopedManagementConsentClient.js'
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const prefix = 'todayaction-scoped-consent-pending-v1:'
const schema = scopedConsentDecisionSchema
function storage(given?: PendingStorage) {
  if (given) return given
  try {
    return window.sessionStorage
  } catch {
    throw new ScopedConsentError(
      'PENDING_STORAGE_UNAVAILABLE',
      '无法保存本标签页的请求编号，请不要再次授权。',
    )
  }
}
export function readPendingScopedConsent(
  accountId: string,
  given?: PendingStorage,
): ScopedConsentDecision | null {
  try {
    const raw = storage(given).getItem(prefix + accountId)
    if (!raw) return null
    if (raw.length > 8192) throw new Error('oversized')
    const parsed = schema.parse(JSON.parse(raw))
    if (parsed.expectedAccountId !== accountId)
      throw new Error('account mismatch')
    for (const choice of parsed.choices) { if (choice.expectedGrant) Object.freeze(choice.expectedGrant); Object.freeze(choice) }
    Object.freeze(parsed.choices)
    return Object.freeze(parsed)

  } catch {
    throw new ScopedConsentError(
      'PENDING_STATE_INVALID',
      '无法核对本标签页之前的未确认请求，请先核对当前授权状态。',
    )
  }
}
/** Only decision metadata, never session/access/refresh tokens. Saved before POST. */
export function savePendingScopedConsent(
  body: ScopedConsentDecision,
  given?: PendingStorage,
) {
  try {
    const parsed = schema.parse(body),
      target = storage(given),
      existing = readPendingScopedConsent(parsed.expectedAccountId, target)
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed))
      throw new ScopedConsentError(
        'PENDING_CONFLICT',
        '本标签页还有另一个未确认请求。请重新读取，不能覆盖它的请求编号。',
      )
    target.setItem(prefix + parsed.expectedAccountId, JSON.stringify(parsed))
  } catch (caught) {
    if (caught instanceof ScopedConsentError) throw caught
    throw new ScopedConsentError(
      'PENDING_STORAGE_UNAVAILABLE',
      '无法保存请求编号，尚未发送本次授权操作。',
    )
  }
}
/** A late receipt from an older document must never remove a newer pending intent. */
export function clearPendingScopedConsent(
  body: ScopedConsentDecision,
  given?: PendingStorage,
) {
  try {
    const parsed = schema.parse(body),
      target = storage(given),
      existing = readPendingScopedConsent(parsed.expectedAccountId, target)
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed))
      return false
    target.removeItem(prefix + parsed.expectedAccountId)
    return true
  } catch {
    return false
  }
}
