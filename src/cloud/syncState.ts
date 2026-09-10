export interface CloudConflictState {
  remoteVersion: string
  remoteFingerprint: string
  remoteUpdatedAt: string
  remoteDeviceId?: string
  remoteFileId?: string
}

export interface AccountSyncCheckpoint {
  lastSyncedVersion?: string
  lastSyncedFingerprint?: string
  lastSyncedAt?: string
  lastError?: string
  conflict?: CloudConflictState
}

export interface CloudDeviceState {
  version: 2
  deviceId: string
  autoSync: boolean
  workspaceOwnerUserId?: string
  accounts: Record<string, AccountSyncCheckpoint>
}

const STORAGE_KEY = 'pjsdas-google-drive-sync-state-v2'

function randomDeviceId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function freshState(): CloudDeviceState {
  return { version: 2, deviceId: randomDeviceId(), autoSync: true, accounts: {} }
}

function readRaw(): CloudDeviceState {
  if (typeof window === 'undefined') return freshState()
  try {
    const text = window.localStorage.getItem(STORAGE_KEY)
    if (!text) {
      const next = freshState()
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    }
    const parsed = JSON.parse(text) as Partial<CloudDeviceState>
    if (parsed.version !== 2 || !parsed.deviceId || typeof parsed.autoSync !== 'boolean') throw new Error('invalid')
    return {
      version: 2,
      deviceId: parsed.deviceId,
      autoSync: parsed.autoSync,
      workspaceOwnerUserId: parsed.workspaceOwnerUserId,
      accounts: parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {},
    }
  } catch {
    const next = freshState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    return next
  }
}

function writeRaw(state: CloudDeviceState) {
  if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  return state
}

export function getCloudDeviceState() {
  return readRaw()
}

export function getAccountCheckpoint(userId: string) {
  return readRaw().accounts[userId] ?? {}
}

export function patchAccountCheckpoint(userId: string, patch: Partial<AccountSyncCheckpoint>) {
  const state = readRaw()
  const current = state.accounts[userId] ?? {}
  const next: AccountSyncCheckpoint = { ...current, ...patch }
  if (patch.conflict === undefined && 'conflict' in patch) delete next.conflict
  if (patch.lastError === undefined && 'lastError' in patch) delete next.lastError
  state.accounts[userId] = next
  return writeRaw(state)
}

export function bindLocalWorkspaceToUser(userId: string, resetCheckpoint = false) {
  const state = readRaw()
  state.workspaceOwnerUserId = userId
  if (resetCheckpoint) state.accounts[userId] = {}
  return writeRaw(state)
}

export function setCloudAutoSync(enabled: boolean) {
  const state = readRaw()
  state.autoSync = enabled
  return writeRaw(state)
}
