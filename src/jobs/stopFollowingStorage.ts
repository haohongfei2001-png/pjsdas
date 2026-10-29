/** A notification filter only: event bytes never supply account/write authority. */
const SYNC_STATE_KEY = 'pjsdas-google-drive-sync-state-v2'
const rootKeys = ['version', 'deviceId', 'autoSync', 'workspaceOwnerUserId', 'accounts']
const checkpointKeys = ['clearedCacheFingerprint', 'lastSyncedVersion', 'lastSyncedFingerprint',
  'lastReadProjectionFingerprint', 'lastReadProjectionSourceFingerprint', 'localPendingFingerprint',
  'lastSyncedAt', 'lastError', 'conflict']
const conflictKeys = ['remoteVersion', 'remoteFingerprint', 'remoteUpdatedAt', 'remoteDeviceId', 'remoteFileId']
type RecordValue = Record<string, unknown>
const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const knownKeys = (value: RecordValue, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
function checkpoint(value: unknown): value is RecordValue {
  if (!object(value) || !knownKeys(value, checkpointKeys)) return false
  return Object.entries(value).every(([key, item]) => {
    if (key === 'lastSyncedAt') return readTimestamp(item)
    if (key !== 'conflict') return typeof item === 'string'
    return object(item) && knownKeys(item, conflictKeys)
      && ['remoteVersion', 'remoteFingerprint', 'remoteUpdatedAt'].every(field => Object.hasOwn(item, field) && typeof item[field] === 'string')
      && Object.values(item).every(field => typeof field === 'string')
  })
}
function state(value: unknown, accountKey: string): value is RecordValue & { accounts: Record<string, RecordValue> } {
  return object(value) && knownKeys(value, rootKeys) && rootKeys.every(key => Object.hasOwn(value, key)) && value.version === 2
    && typeof value.deviceId === 'string' && value.deviceId.trim().length > 0
    && typeof value.autoSync === 'boolean' && value.workspaceOwnerUserId === accountKey
    && object(value.accounts) && Object.hasOwn(value.accounts, accountKey)
    && Object.values(value.accounts).every(checkpoint)
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!object(a) || !object(b)) return false
  const keys = Object.keys(a), other = Object.keys(b)
  return keys.length === other.length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}
function readTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value
}

/** Ignore only a well-formed current-owner read timestamp change. Everything
 * unknown, malformed, removed, or otherwise changed must retain normal refresh.
 * The caller still reads its real storage and validates its original lease. */
export function isStopFollowingReadTimestampOnly(
  event: Pick<StorageEvent, 'key' | 'oldValue' | 'newValue' | 'storageArea'>,
  accountKey: string | undefined,
  localStorage: Storage,
): boolean {
  try {
    if (!accountKey || event.storageArea !== localStorage || event.key !== SYNC_STATE_KEY
      || event.oldValue === null || event.newValue === null) return false
    const before: unknown = JSON.parse(event.oldValue), after: unknown = JSON.parse(event.newValue)
    if (!state(before, accountKey) || !state(after, accountKey)) return false
    const oldCheckpoint = before.accounts[accountKey]!, nextCheckpoint = after.accounts[accountKey]!
    if (!Object.hasOwn(oldCheckpoint, 'lastSyncedAt') || !Object.hasOwn(nextCheckpoint, 'lastSyncedAt')
      || !readTimestamp(oldCheckpoint.lastSyncedAt) || !readTimestamp(nextCheckpoint.lastSyncedAt)
      || oldCheckpoint.lastSyncedAt === nextCheckpoint.lastSyncedAt) return false
    // These are freshly parsed event copies, not live storage or caller objects.
    delete oldCheckpoint.lastSyncedAt; delete nextCheckpoint.lastSyncedAt
    return equal(before, after)
  } catch { return false }
}
