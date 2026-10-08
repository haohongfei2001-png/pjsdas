import type { CloudDeviceState } from './syncState.js'
import { mockCloudMode, MOCK_AUTH_ORIGIN, MOCK_AUTH_STORAGE_KEY, MOCK_BACKEND_ORIGIN } from './runtimeCloudMode.js'
import { AccountCacheChangedError, currentAccountCacheGeneration, currentAccountCacheSession } from './accountCacheLease.js'

export const MOCK_CACHE_PROVENANCE_KEY = 'todayaction-mock-cache-provenance-v1'
type StorageView = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type MockCacheProof = { version: 1; owner: string; deviceId: string; authOrigin: string; backendOrigin: string; authStorageKey: string; fingerprint: string; tokenSha256: string }
// Page-lifetime evidence only. A persisted marker by itself never authorizes
// clearing an unknown cache. A failed clear can survive a recovery remount,
// but neither a reload nor a new Auth/cache generation can inherit its intent.
const verifiedThisPage = new WeakMap<StorageView, string>()
type PendingClear = { proof: string; generation: number; account?: string; auth: string | null; running?: Promise<void> }
const pendingClears = new WeakMap<StorageView, PendingClear>()
type InitialBinding = { owner: string; deviceId: string; generation: number; token: string }
const initialBindings = new WeakMap<StorageView, InitialBinding>()
export const MOCK_CACHE_STOP = '本地模拟模式已暂停：现有账号缓存的来源未能确认。缓存已保留，请使用明确的 live 配置恢复原账号。 / Local mock mode is paused because the account cache origin is unconfirmed. The cache is preserved; restore its account with explicit live configuration.'

function readProof(storage: StorageView): MockCacheProof | undefined {
  try { return JSON.parse(storage.getItem(MOCK_CACHE_PROVENANCE_KEY) ?? 'null') ?? undefined } catch { return undefined }
}
function sessionToken(storage: StorageView, owner: string, now: number) {
  try {
    const session = JSON.parse(storage.getItem(MOCK_AUTH_STORAGE_KEY) ?? 'null')
    const subject = session?.user?.user_metadata?.sub ?? session?.user?.id
    if (subject !== owner || typeof session?.access_token !== 'string' || !session.access_token
      || !Number.isFinite(session.expires_at) || session.expires_at * 1000 <= now) return undefined
    // This is only an origin-consistency check, never authentication. Real JWT
    // sessions copied to the mock namespace must not identify a mock cache.
    const parts = session.access_token.split('.')
    if (parts.length === 3) {
      const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
      if (typeof claims.iss !== 'string' || new URL(claims.iss).origin !== MOCK_AUTH_ORIGIN) return undefined
    }
    return session.access_token as string
  } catch { return undefined }
}
/** Remember only a binding that began unowned in this mock page/session. A
 * competing verified reader may finish it; an old stored binding cannot. */
export function rememberInitialMockBinding(storage: StorageView, state: CloudDeviceState, owner: string) {
  if (!mockCloudMode() || state.workspaceOwnerUserId || currentAccountCacheSession() !== owner) return
  const token = sessionToken(storage, owner, Date.now())
  if (token) initialBindings.set(storage, { owner, deviceId: state.deviceId, generation: currentAccountCacheGeneration(), token })
}
export function hasInitialMockBinding(storage: StorageView, state: CloudDeviceState, owner: string) {
  const initial = initialBindings.get(storage)
  return Boolean(mockCloudMode() && initial && initial.owner === owner && state.workspaceOwnerUserId === owner
    && initial.deviceId === state.deviceId && currentAccountCacheSession() === owner
    && initial.generation === currentAccountCacheGeneration() && sessionToken(storage, owner, Date.now()) === initial.token)
}
async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
/** Development accident-prevention metadata only. It never grants access,
 * supplies an account ID to authorization, restores data or bypasses the
 * ordinary account/cache boundary. Missing or contradictory proof stops. */
export function hasMockCacheProvenance(storage: StorageView, state: CloudDeviceState) {
  const owner = state.workspaceOwnerUserId, proof = readProof(storage)
  return Boolean(owner && proof?.version === 1 && proof.owner === owner && proof.deviceId === state.deviceId
    && proof.authOrigin === MOCK_AUTH_ORIGIN && proof.backendOrigin === MOCK_BACKEND_ORIGIN && proof.authStorageKey === MOCK_AUTH_STORAGE_KEY
    && proof.fingerprint && proof.fingerprint === state.accounts[owner]?.lastSyncedFingerprint
    && state.accounts[owner]?.lastSyncedVersion && /^[a-f0-9]{64}$/.test(proof.tokenSha256))
}
export async function canMountMockAccountCache(storage: StorageView, readState: CloudDeviceState | (() => CloudDeviceState), now = Date.now()) {
  const state = typeof readState === 'function' ? readState() : readState
  if (!state.workspaceOwnerUserId) return true
  if (!hasMockCacheProvenance(storage, state)) return false
  const token = sessionToken(storage, state.workspaceOwnerUserId, now)
  if (!token) return false
  const digest = await sha256(token)
  const current = typeof readState === 'function' ? readState() : readState
  const allowed = current.workspaceOwnerUserId === state.workspaceOwnerUserId && current.deviceId === state.deviceId
    && current.accounts[state.workspaceOwnerUserId]?.lastSyncedFingerprint === state.accounts[state.workspaceOwnerUserId]?.lastSyncedFingerprint
    && hasMockCacheProvenance(storage, current) && sessionToken(storage, state.workspaceOwnerUserId, Math.max(now, Date.now())) === token
    && readProof(storage)?.tokenSha256 === digest
  if (allowed) verifiedThisPage.set(storage, storage.getItem(MOCK_CACHE_PROVENANCE_KEY)!)
  return allowed
}
/** Call only after a new/mock-authorized binding has completed a verified sync.
 * The caller must recheck the same account lease after this awaited hash. */
export async function markVerifiedMockCache(storage: StorageView, readState: () => CloudDeviceState, owner: string, assertCurrent: () => void, now = Date.now()) {
  assertCurrent()
  const before = readState(), checkpoint = before.accounts[owner]
  if (before.workspaceOwnerUserId !== owner || !checkpoint?.lastSyncedFingerprint || !checkpoint.lastSyncedVersion) return
  const token = sessionToken(storage, owner, now)
  if (!token) return
  const tokenSha256 = await sha256(token)
  assertCurrent()
  const current = readState()
  if (current.workspaceOwnerUserId !== owner || current.deviceId !== before.deviceId
    || current.accounts[owner]?.lastSyncedFingerprint !== checkpoint.lastSyncedFingerprint
    || sessionToken(storage, owner, Math.max(now, Date.now())) !== token) return
  storage.setItem(MOCK_CACHE_PROVENANCE_KEY, JSON.stringify({ version: 1, owner, deviceId: before.deviceId,
    authOrigin: MOCK_AUTH_ORIGIN, backendOrigin: MOCK_BACKEND_ORIGIN, authStorageKey: MOCK_AUTH_STORAGE_KEY,
    fingerprint: checkpoint.lastSyncedFingerprint, tokenSha256 } satisfies MockCacheProof))
  verifiedThisPage.set(storage, storage.getItem(MOCK_CACHE_PROVENANCE_KEY)!)
  initialBindings.delete(storage)
}
export function forgetMockCacheProvenance(storage: StorageView) {
  storage.removeItem(MOCK_CACHE_PROVENANCE_KEY)
  verifiedThisPage.delete(storage)
  pendingClears.delete(storage)
  initialBindings.delete(storage)
}

function clearIsCurrent(storage: StorageView, state: CloudDeviceState, pending: PendingClear) {
  return hasMockCacheProvenance(storage, state) && storage.getItem(MOCK_CACHE_PROVENANCE_KEY) === pending.proof
    && currentAccountCacheGeneration() === pending.generation && currentAccountCacheSession() === pending.account
    && storage.getItem(MOCK_AUTH_STORAGE_KEY) === pending.auth
}
export function hasPendingMockCacheClear(storage: StorageView, state: CloudDeviceState) {
  const pending = pendingClears.get(storage)
  if (!pending) return false
  if (clearIsCurrent(storage, state, pending)) return true
  pendingClears.delete(storage)
  return false
}
/** Only continues the ordinary account-boundary clear after a verified mock
 * session is lost or replaced. It supplies no session or authorization. */
export async function clearVerifiedMockAccountCache(storage: StorageView, readState: () => CloudDeviceState, clear: (assertCurrent: () => void) => Promise<void>) {
  let pending = pendingClears.get(storage)
  if (pending && !clearIsCurrent(storage, readState(), pending)) {
    pendingClears.delete(storage)
    throw new AccountCacheChangedError()
  }
  if (!pending) {
    const state = readState(), proof = storage.getItem(MOCK_CACHE_PROVENANCE_KEY)
    if (!proof || !hasMockCacheProvenance(storage, state) || verifiedThisPage.get(storage) !== proof) throw new Error(MOCK_CACHE_STOP)
    pending = { proof, generation: currentAccountCacheGeneration(), account: currentAccountCacheSession(), auth: storage.getItem(MOCK_AUTH_STORAGE_KEY) }
    pendingClears.set(storage, pending)
  }
  if (pending.running) return pending.running
  const intent = pending
  const assertCurrent = () => { if (!clearIsCurrent(storage, readState(), intent)) throw new AccountCacheChangedError() }
  const running = Promise.resolve().then(() => { assertCurrent(); return clear(assertCurrent) })
  intent.running = running
  try { await running; if (pendingClears.get(storage) === intent) pendingClears.delete(storage) }
  finally { if (intent.running === running) intent.running = undefined }
}

/** Preserve an already established mock binding through verified checkpoint
 * advances. This cannot create proof for an unknown/legacy binding. Live
 * writes invalidate this development-only proof before it can be reused. */
export function advanceExistingMockCacheProof(storage: StorageView, before: CloudDeviceState, after: CloudDeviceState) {
  if (!mockCloudMode()) { forgetMockCacheProvenance(storage); return }
  if (!hasMockCacheProvenance(storage, before) || before.workspaceOwnerUserId !== after.workspaceOwnerUserId || before.deviceId !== after.deviceId) return
  const fingerprint = after.accounts[after.workspaceOwnerUserId!]?.lastSyncedFingerprint
  if (!fingerprint) return
  const proof = readProof(storage)!
  const remembered = verifiedThisPage.get(storage) === storage.getItem(MOCK_CACHE_PROVENANCE_KEY)
  storage.setItem(MOCK_CACHE_PROVENANCE_KEY, JSON.stringify({ ...proof, fingerprint }))
  if (remembered) verifiedThisPage.set(storage, storage.getItem(MOCK_CACHE_PROVENANCE_KEY)!)
}
