from pathlib import Path

root = Path('.')
cloud = root / 'src' / 'cloud'

(cloud / 'cloudConfig.ts').write_text(r'''export interface CloudConfig {
  clientId: string
}

export const GOOGLE_DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
export const GOOGLE_OAUTH_SCOPES = ['openid', 'email', 'profile', GOOGLE_DRIVE_APPDATA_SCOPE].join(' ')

export function readCloudConfig(): CloudConfig | null {
  const env = import.meta.env as Record<string, string | undefined>
  const clientId = (env.VITE_GOOGLE_CLIENT_ID ?? '').trim()
  if (!clientId) return null
  return { clientId }
}
''')

(cloud / 'cloudClient.ts').write_text(r'''import { GOOGLE_OAUTH_SCOPES, readCloudConfig } from './cloudConfig'

export interface CloudUser {
  id: string
  email?: string
  user_metadata: {
    full_name?: string
    avatar_url?: string
  }
}

export interface CloudSession {
  user: CloudUser
  expiresAt: number
}

type GoogleTokenResponse = {
  access_token?: string
  expires_in?: number | string
  scope?: string
  token_type?: string
  error?: string
  error_description?: string
}

type GoogleTokenClient = {
  requestAccessToken: (overrideConfig?: { prompt?: string; hint?: string }) => void
}

type GoogleOauth = {
  initTokenClient: (config: {
    client_id: string
    scope: string
    include_granted_scopes?: boolean
    callback: (response: GoogleTokenResponse) => void
    error_callback?: (error: unknown) => void
  }) => GoogleTokenClient
  revoke?: (token: string, done?: () => void) => void
}

type GoogleWindow = Window & {
  google?: {
    accounts?: {
      oauth2?: GoogleOauth
    }
  }
}

type UserInfo = {
  sub?: string
  email?: string
  name?: string
  picture?: string
}

let gisPromise: Promise<GoogleOauth> | undefined
let accessToken: string | undefined
let session: CloudSession | null = null

function oauthFromWindow() {
  if (typeof window === 'undefined') return undefined
  return (window as GoogleWindow).google?.accounts?.oauth2
}

function loadGoogleIdentityServices(): Promise<GoogleOauth> {
  const existing = oauthFromWindow()
  if (existing) return Promise.resolve(existing)
  if (gisPromise) return gisPromise

  gisPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Google 登录只能在浏览器中使用。'))
      return
    }

    const finish = () => {
      const oauth = oauthFromWindow()
      if (oauth) resolve(oauth)
      else reject(new Error('Google Identity Services 已加载，但 OAuth 客户端不可用。'))
    }

    const current = document.querySelector<HTMLScriptElement>('script[data-pjsdas-google-identity]')
    if (current) {
      current.addEventListener('load', finish, { once: true })
      current.addEventListener('error', () => reject(new Error('无法加载 Google Identity Services。')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.dataset.pjsdasGoogleIdentity = 'true'
    script.addEventListener('load', finish, { once: true })
    script.addEventListener('error', () => reject(new Error('无法加载 Google Identity Services。')), { once: true })
    document.head.appendChild(script)
  })

  return gisPromise
}

function clearMemorySession() {
  accessToken = undefined
  session = null
}

export function invalidateCloudSession() {
  clearMemorySession()
}

export function getCloudAccessToken() {
  if (!accessToken || !session || Date.now() >= session.expiresAt - 30_000) {
    clearMemorySession()
    throw new Error('Google Drive 授权已过期，请重新连接 Google 账号。')
  }
  return accessToken
}

export async function getCloudSession(): Promise<CloudSession | null> {
  if (!session || !accessToken || Date.now() >= session.expiresAt - 30_000) {
    clearMemorySession()
    return null
  }
  return session
}

async function fetchUserInfo(token: string): Promise<CloudUser> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`读取 Google 账号信息失败（HTTP ${response.status}）。`)
  const data = await response.json() as UserInfo
  if (!data.sub) throw new Error('Google 账号缺少稳定用户标识。')
  return {
    id: data.sub,
    email: data.email,
    user_metadata: {
      full_name: data.name,
      avatar_url: data.picture,
    },
  }
}

export async function signInWithGoogle(): Promise<CloudSession> {
  const config = readCloudConfig()
  if (!config) throw new Error('Google Drive 同步尚未配置。')
  const oauth = await loadGoogleIdentityServices()

  const token = await new Promise<{ accessToken: string; expiresInSeconds: number }>((resolve, reject) => {
    const client = oauth.initTokenClient({
      client_id: config.clientId,
      scope: GOOGLE_OAUTH_SCOPES,
      include_granted_scopes: true,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || 'Google 授权失败。'))
          return
        }
        const expires = Number(response.expires_in ?? 3600)
        resolve({ accessToken: response.access_token, expiresInSeconds: Number.isFinite(expires) ? expires : 3600 })
      },
      error_callback: () => reject(new Error('Google 授权窗口被关闭或无法打开。')),
    })
    client.requestAccessToken()
  })

  const user = await fetchUserInfo(token.accessToken)
  accessToken = token.accessToken
  session = {
    user,
    expiresAt: Date.now() + token.expiresInSeconds * 1000,
  }
  return session
}

export async function signOutCloud() {
  const token = accessToken
  clearMemorySession()
  if (!token) return
  try {
    const oauth = await loadGoogleIdentityServices()
    if (oauth.revoke) await new Promise<void>((resolve) => oauth.revoke?.(token, resolve))
  } catch {
    // Local sign-out is sufficient if the Google script is unavailable.
  }
}
''')

(cloud / 'driveEnvelope.ts').write_text(r'''import type { PJSDASSnapshot } from '../snapshot'

export const DRIVE_WORKSPACE_SCHEMA = 'pjsdas-google-drive-workspace' as const
export const DRIVE_WORKSPACE_ENVELOPE_VERSION = 1 as const
export const DRIVE_WORKSPACE_FILENAME = 'pjsdas-workspace.json'

export interface DriveWorkspaceEnvelope {
  schema: typeof DRIVE_WORKSPACE_SCHEMA
  version: typeof DRIVE_WORKSPACE_ENVELOPE_VERSION
  fingerprint: string
  updatedByDevice: string
  updatedAt: string
  snapshot: PJSDASSnapshot
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createDriveWorkspaceEnvelope(input: {
  fingerprint: string
  deviceId: string
  snapshot: PJSDASSnapshot
  updatedAt?: string
}): DriveWorkspaceEnvelope {
  return {
    schema: DRIVE_WORKSPACE_SCHEMA,
    version: DRIVE_WORKSPACE_ENVELOPE_VERSION,
    fingerprint: input.fingerprint,
    updatedByDevice: input.deviceId,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    snapshot: input.snapshot,
  }
}

export function parseDriveWorkspaceEnvelope(value: unknown): DriveWorkspaceEnvelope {
  if (!isObject(value)) throw new Error('Google Drive 中的 PJSDAS 工作区格式无效。')
  if (value.schema !== DRIVE_WORKSPACE_SCHEMA || value.version !== DRIVE_WORKSPACE_ENVELOPE_VERSION) {
    throw new Error('Google Drive 中的 PJSDAS 工作区版本不受支持。')
  }
  if (typeof value.fingerprint !== 'string' || !value.fingerprint || typeof value.updatedByDevice !== 'string' || !value.updatedByDevice) {
    throw new Error('Google Drive 工作区缺少同步元数据。')
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(new Date(value.updatedAt).getTime())) {
    throw new Error('Google Drive 工作区更新时间无效。')
  }
  if (!isObject(value.snapshot)) throw new Error('Google Drive 工作区缺少 PJSDAS Snapshot。')
  return value as unknown as DriveWorkspaceEnvelope
}
''')

(cloud / 'cloudRepository.ts').write_text(r'''import type { PJSDASSnapshot } from '../snapshot'
import { getCloudAccessToken, invalidateCloudSession } from './cloudClient'
import {
  DRIVE_WORKSPACE_FILENAME,
  createDriveWorkspaceEnvelope,
  parseDriveWorkspaceEnvelope,
} from './driveEnvelope'

export interface RemoteWorkspaceRow {
  fileId: string
  version: string
  schemaVersion: number
  fingerprint: string
  snapshot: PJSDASSnapshot
  updatedByDevice: string
  updatedAt: string
}

type DriveFileMetadata = {
  id?: string
  name?: string
  version?: string | number
  modifiedTime?: string
}

type DriveFileList = {
  files?: DriveFileMetadata[]
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const metadataFields = 'id,name,version,modifiedTime'

async function errorMessage(response: Response) {
  try {
    const data = await response.json() as { error?: { message?: string } }
    return data.error?.message || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

async function driveFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${getCloudAccessToken()}`)
  const response = await fetch(url, { ...init, headers })
  if (response.status === 401) {
    invalidateCloudSession()
    throw new Error('Google Drive 授权已过期，请重新连接 Google 账号。')
  }
  if (!response.ok) throw new Error(`Google Drive 请求失败：${await errorMessage(response)}`)
  return response
}

async function listWorkspaceFiles() {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${DRIVE_WORKSPACE_FILENAME}' and trashed = false`,
    fields: `files(${metadataFields})`,
    pageSize: '10',
    orderBy: 'modifiedTime desc',
  })
  const response = await driveFetch(`${DRIVE_API}/files?${params.toString()}`)
  const data = await response.json() as DriveFileList
  const files = data.files ?? []
  if (files.length > 1) {
    throw new Error('Google Drive 的 PJSDAS 隐藏目录中出现了多个工作区文件。为避免覆盖错误数据，同步已停止。')
  }
  return files
}

async function metadataForFile(fileId: string) {
  const params = new URLSearchParams({ fields: metadataFields })
  const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`)
  const data = await response.json() as DriveFileMetadata
  if (!data.id || data.version === undefined || !data.modifiedTime) throw new Error('Google Drive 返回的工作区元数据不完整。')
  return {
    id: data.id,
    version: String(data.version),
    modifiedTime: data.modifiedTime,
  }
}

async function downloadEnvelope(fileId: string) {
  const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`)
  return parseDriveWorkspaceEnvelope(await response.json())
}

export async function fetchRemoteWorkspace(_userId: string): Promise<RemoteWorkspaceRow | null> {
  const files = await listWorkspaceFiles()
  const file = files[0]
  if (!file?.id) return null
  const meta = file.version !== undefined && file.modifiedTime
    ? { id: file.id, version: String(file.version), modifiedTime: file.modifiedTime }
    : await metadataForFile(file.id)
  const envelope = await downloadEnvelope(file.id)
  return {
    fileId: meta.id,
    version: meta.version,
    schemaVersion: envelope.version,
    fingerprint: envelope.fingerprint,
    snapshot: envelope.snapshot,
    updatedByDevice: envelope.updatedByDevice,
    updatedAt: meta.modifiedTime || envelope.updatedAt,
  }
}

export async function createRemoteWorkspace(input: {
  userId: string
  fingerprint: string
  snapshot: PJSDASSnapshot
  deviceId: string
}): Promise<RemoteWorkspaceRow | null> {
  void input.userId
  if ((await listWorkspaceFiles()).length > 0) return null
  const envelope = createDriveWorkspaceEnvelope({
    fingerprint: input.fingerprint,
    snapshot: input.snapshot,
    deviceId: input.deviceId,
  })
  const boundary = `pjsdas-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
  const metadata = JSON.stringify({
    name: DRIVE_WORKSPACE_FILENAME,
    mimeType: 'application/json',
    parents: ['appDataFolder'],
    appProperties: { pjsdasWorkspace: 'v1' },
  })
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(envelope),
    `--${boundary}--`,
    '',
  ].join('\r\n')
  const params = new URLSearchParams({ uploadType: 'multipart', fields: metadataFields })
  const response = await driveFetch(`${DRIVE_UPLOAD_API}/files?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  const meta = await response.json() as DriveFileMetadata
  if (!meta.id || meta.version === undefined || !meta.modifiedTime) throw new Error('Google Drive 创建工作区后未返回完整元数据。')
  return {
    fileId: meta.id,
    version: String(meta.version),
    schemaVersion: envelope.version,
    fingerprint: envelope.fingerprint,
    snapshot: envelope.snapshot,
    updatedByDevice: envelope.updatedByDevice,
    updatedAt: meta.modifiedTime,
  }
}

export async function updateRemoteWorkspace(input: {
  userId: string
  fileId: string
  expectedVersion: string
  fingerprint: string
  snapshot: PJSDASSnapshot
  deviceId: string
}): Promise<RemoteWorkspaceRow | null> {
  void input.userId
  const before = await metadataForFile(input.fileId)
  if (before.version !== input.expectedVersion) return null

  const envelope = createDriveWorkspaceEnvelope({
    fingerprint: input.fingerprint,
    snapshot: input.snapshot,
    deviceId: input.deviceId,
  })
  const params = new URLSearchParams({ uploadType: 'media', fields: metadataFields })
  const response = await driveFetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(input.fileId)}?${params.toString()}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(envelope),
  })
  const meta = await response.json() as DriveFileMetadata
  if (!meta.id || meta.version === undefined || !meta.modifiedTime) throw new Error('Google Drive 更新工作区后未返回完整元数据。')
  return {
    fileId: meta.id,
    version: String(meta.version),
    schemaVersion: envelope.version,
    fingerprint: envelope.fingerprint,
    snapshot: envelope.snapshot,
    updatedByDevice: envelope.updatedByDevice,
    updatedAt: meta.modifiedTime,
  }
}
''')

(cloud / 'syncLogic.ts').write_text(r'''export interface SyncCheckpointInput {
  lastSyncedVersion?: string
  lastSyncedFingerprint?: string
}

export interface RemoteWorkspaceVersion {
  version: string
  fingerprint: string
}

export type SyncDecision =
  | 'create_remote'
  | 'push_local'
  | 'pull_remote'
  | 'adopt_equal'
  | 'noop'
  | 'conflict'

export function decideSyncAction(input: {
  checkpoint: SyncCheckpointInput
  localFingerprint: string
  localEmpty: boolean
  remote: RemoteWorkspaceVersion | null
}): SyncDecision {
  const { checkpoint, localFingerprint, localEmpty, remote } = input
  if (!remote) return 'create_remote'
  if (remote.fingerprint === localFingerprint) return 'adopt_equal'

  if (!checkpoint.lastSyncedVersion || !checkpoint.lastSyncedFingerprint) {
    return localEmpty ? 'pull_remote' : 'conflict'
  }

  const localChanged = localFingerprint !== checkpoint.lastSyncedFingerprint
  const remoteChanged = remote.version !== checkpoint.lastSyncedVersion ||
    remote.fingerprint !== checkpoint.lastSyncedFingerprint

  if (!localChanged && !remoteChanged) return 'noop'
  if (localChanged && !remoteChanged) return 'push_local'
  if (!localChanged && remoteChanged) return 'pull_remote'
  return 'conflict'
}
''')

(cloud / 'syncState.ts').write_text(r'''export interface CloudConflictState {
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
''')

(cloud / 'cloudSync.ts').write_text(r'''import { exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../db'
import { validateSnapshot } from '../snapshot'
import {
  bindLocalWorkspaceToUser,
  getAccountCheckpoint,
  getCloudDeviceState,
  patchAccountCheckpoint,
  type CloudConflictState,
} from './syncState'
import { decideSyncAction } from './syncLogic'
import {
  createRemoteWorkspace,
  fetchRemoteWorkspace,
  updateRemoteWorkspace,
  type RemoteWorkspaceRow,
} from './cloudRepository'
import { fingerprintWorkspace, workspaceIsEffectivelyEmpty } from './workspaceFingerprint'

export type CloudSyncOutcomeKind =
  | 'created'
  | 'pushed'
  | 'pulled'
  | 'synced'
  | 'conflict'
  | 'account_mismatch'

export interface CloudSyncOutcome {
  kind: CloudSyncOutcomeKind
  version?: string
  remoteUpdatedAt?: string
}

async function verifyRemote(row: RemoteWorkspaceRow) {
  if (row.schemaVersion !== 1) throw new Error(`不支持 Google Drive 工作区 schema v${row.schemaVersion}。`)
  validateSnapshot(row.snapshot)
  const fingerprint = await fingerprintWorkspace(row.snapshot)
  if (fingerprint !== row.fingerprint) throw new Error('Google Drive 工作区指纹校验失败，已停止同步。')
  return row
}

function conflictFromRemote(row: RemoteWorkspaceRow): CloudConflictState {
  return {
    remoteVersion: row.version,
    remoteFingerprint: row.fingerprint,
    remoteUpdatedAt: row.updatedAt,
    remoteDeviceId: row.updatedByDevice,
    remoteFileId: row.fileId,
  }
}

function markSynced(userId: string, row: RemoteWorkspaceRow) {
  patchAccountCheckpoint(userId, {
    lastSyncedVersion: row.version,
    lastSyncedFingerprint: row.fingerprint,
    lastSyncedAt: new Date().toISOString(),
    conflict: undefined,
    lastError: undefined,
  })
}

function markConflict(userId: string, row: RemoteWorkspaceRow) {
  patchAccountCheckpoint(userId, {
    conflict: conflictFromRemote(row),
    lastError: undefined,
  })
}

export async function runCloudSync(userId: string): Promise<CloudSyncOutcome> {
  const device = getCloudDeviceState()
  if (device.workspaceOwnerUserId && device.workspaceOwnerUserId !== userId) {
    return { kind: 'account_mismatch' }
  }
  if (!device.workspaceOwnerUserId) bindLocalWorkspaceToUser(userId)

  try {
    const local = await exportLocalSnapshot()
    const localFingerprint = await fingerprintWorkspace(local)
    const remoteRaw = await fetchRemoteWorkspace(userId)
    const remote = remoteRaw ? await verifyRemote(remoteRaw) : null
    const checkpoint = getAccountCheckpoint(userId)
    const decision = decideSyncAction({
      checkpoint,
      localFingerprint,
      localEmpty: workspaceIsEffectivelyEmpty(local),
      remote: remote ? { version: remote.version, fingerprint: remote.fingerprint } : null,
    })

    if (decision === 'create_remote') {
      const created = await createRemoteWorkspace({
        userId,
        fingerprint: localFingerprint,
        snapshot: local,
        deviceId: device.deviceId,
      })
      if (!created) {
        const raced = await fetchRemoteWorkspace(userId)
        if (!raced) throw new Error('Google Drive 工作区创建冲突，但无法读取最新版本。')
        const verified = await verifyRemote(raced)
        markConflict(userId, verified)
        return { kind: 'conflict', version: verified.version, remoteUpdatedAt: verified.updatedAt }
      }
      markSynced(userId, created)
      return { kind: 'created', version: created.version, remoteUpdatedAt: created.updatedAt }
    }

    if (!remote) throw new Error('同步状态异常：预期存在 Google Drive 工作区。')

    if (decision === 'push_local') {
      const updated = await updateRemoteWorkspace({
        userId,
        fileId: remote.fileId,
        expectedVersion: remote.version,
        fingerprint: localFingerprint,
        snapshot: local,
        deviceId: device.deviceId,
      })
      if (!updated) {
        const latest = await fetchRemoteWorkspace(userId)
        if (!latest) throw new Error('Google Drive 工作区在同步过程中消失。')
        const verified = await verifyRemote(latest)
        markConflict(userId, verified)
        return { kind: 'conflict', version: verified.version, remoteUpdatedAt: verified.updatedAt }
      }
      markSynced(userId, updated)
      return { kind: 'pushed', version: updated.version, remoteUpdatedAt: updated.updatedAt }
    }

    if (decision === 'pull_remote') {
      await replaceLocalSnapshotFromCloud(remote.snapshot)
      markSynced(userId, remote)
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
      return { kind: 'pulled', version: remote.version, remoteUpdatedAt: remote.updatedAt }
    }

    if (decision === 'conflict') {
      markConflict(userId, remote)
      return { kind: 'conflict', version: remote.version, remoteUpdatedAt: remote.updatedAt }
    }

    markSynced(userId, remote)
    return { kind: 'synced', version: remote.version, remoteUpdatedAt: remote.updatedAt }
  } catch (caught) {
    patchAccountCheckpoint(userId, {
      lastError: caught instanceof Error ? caught.message : String(caught),
    })
    throw caught
  }
}

export async function resolveConflictKeepLocal(userId: string): Promise<CloudSyncOutcome> {
  const device = getCloudDeviceState()
  const local = await exportLocalSnapshot()
  const fingerprint = await fingerprintWorkspace(local)
  const remoteRaw = await fetchRemoteWorkspace(userId)
  if (!remoteRaw) {
    bindLocalWorkspaceToUser(userId, true)
    return runCloudSync(userId)
  }
  const remote = await verifyRemote(remoteRaw)
  const updated = await updateRemoteWorkspace({
    userId,
    fileId: remote.fileId,
    expectedVersion: remote.version,
    fingerprint,
    snapshot: local,
    deviceId: device.deviceId,
  })
  if (!updated) {
    const latest = await fetchRemoteWorkspace(userId)
    if (!latest) throw new Error('Google Drive 工作区在冲突解决过程中消失。')
    const verified = await verifyRemote(latest)
    markConflict(userId, verified)
    return { kind: 'conflict', version: verified.version, remoteUpdatedAt: verified.updatedAt }
  }
  bindLocalWorkspaceToUser(userId)
  markSynced(userId, updated)
  return { kind: 'pushed', version: updated.version, remoteUpdatedAt: updated.updatedAt }
}

export async function resolveConflictUseCloud(userId: string): Promise<CloudSyncOutcome> {
  const remoteRaw = await fetchRemoteWorkspace(userId)
  if (!remoteRaw) throw new Error('这个 Google 账号还没有 PJSDAS Drive 工作区。')
  const remote = await verifyRemote(remoteRaw)
  await replaceLocalSnapshotFromCloud(remote.snapshot)
  bindLocalWorkspaceToUser(userId, true)
  markSynced(userId, remote)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
  return { kind: 'pulled', version: remote.version, remoteUpdatedAt: remote.updatedAt }
}

export async function rebindCurrentLocalWorkspace(userId: string) {
  bindLocalWorkspaceToUser(userId, true)
  return runCloudSync(userId)
}
''')

(cloud / 'CloudContext.tsx').write_text(r'''import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  getCloudSession,
  signInWithGoogle,
  signOutCloud,
  type CloudSession,
} from './cloudClient'
import { readCloudConfig } from './cloudConfig'
import {
  getAccountCheckpoint,
  getCloudDeviceState,
  setCloudAutoSync,
  type AccountSyncCheckpoint,
  type CloudDeviceState,
} from './syncState'
import {
  rebindCurrentLocalWorkspace,
  resolveConflictKeepLocal,
  resolveConflictUseCloud,
  runCloudSync,
  type CloudSyncOutcome,
} from './cloudSync'

interface CloudContextValue {
  configured: boolean
  session: CloudSession | null
  loading: boolean
  syncing: boolean
  device: CloudDeviceState
  checkpoint: AccountSyncCheckpoint
  outcome?: CloudSyncOutcome
  error?: string
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  syncNow: () => Promise<CloudSyncOutcome | undefined>
  keepLocal: () => Promise<CloudSyncOutcome | undefined>
  useCloud: () => Promise<CloudSyncOutcome | undefined>
  rebindLocal: () => Promise<CloudSyncOutcome | undefined>
  setAutoSync: (enabled: boolean) => void
}

const CloudContext = createContext<CloudContextValue | null>(null)

export function CloudProvider({ children }: { children: ReactNode }) {
  const configured = Boolean(readCloudConfig())
  const [session, setSession] = useState<CloudSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [device, setDevice] = useState(() => getCloudDeviceState())
  const [checkpoint, setCheckpoint] = useState<AccountSyncCheckpoint>({})
  const [outcome, setOutcome] = useState<CloudSyncOutcome>()
  const [error, setError] = useState<string>()
  const busyRef = useRef(false)

  const refreshState = useCallback((userId?: string) => {
    setDevice(getCloudDeviceState())
    setCheckpoint(userId ? getAccountCheckpoint(userId) : {})
  }, [])

  const clearExpiredSessionIfNeeded = useCallback(async () => {
    const current = await getCloudSession()
    if (!current) {
      setSession(null)
      refreshState()
    }
  }, [refreshState])

  const syncNow = useCallback(async () => {
    const userId = session?.user.id
    if (!configured || !userId || busyRef.current) return undefined
    busyRef.current = true
    setSyncing(true)
    setError(undefined)
    try {
      const result = await runCloudSync(userId)
      setOutcome(result)
      refreshState(userId)
      return result
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      refreshState(userId)
      await clearExpiredSessionIfNeeded()
      throw caught
    } finally {
      busyRef.current = false
      setSyncing(false)
    }
  }, [configured, session?.user.id, refreshState, clearExpiredSessionIfNeeded])

  useEffect(() => {
    const userId = session?.user.id
    if (!configured || !userId || !device.autoSync || checkpoint.conflict) return
    const ownerMismatch = Boolean(device.workspaceOwnerUserId && device.workspaceOwnerUserId !== userId)
    if (ownerMismatch) return

    const initial = window.setTimeout(() => { void syncNow().catch(() => undefined) }, 700)
    const interval = window.setInterval(() => { void syncNow().catch(() => undefined) }, 120_000)
    const focus = () => { void syncNow().catch(() => undefined) }
    window.addEventListener('focus', focus)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
      window.removeEventListener('focus', focus)
    }
  }, [configured, session?.user.id, device.autoSync, device.workspaceOwnerUserId, checkpoint.conflict, syncNow])

  const runResolution = useCallback(async (kind: 'keep' | 'cloud' | 'rebind') => {
    const userId = session?.user.id
    if (!userId || busyRef.current) return undefined
    busyRef.current = true
    setSyncing(true)
    setError(undefined)
    try {
      const result = kind === 'keep'
        ? await resolveConflictKeepLocal(userId)
        : kind === 'cloud'
          ? await resolveConflictUseCloud(userId)
          : await rebindCurrentLocalWorkspace(userId)
      setOutcome(result)
      refreshState(userId)
      return result
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      refreshState(userId)
      await clearExpiredSessionIfNeeded()
      throw caught
    } finally {
      busyRef.current = false
      setSyncing(false)
    }
  }, [session?.user.id, refreshState, clearExpiredSessionIfNeeded])

  const signIn = useCallback(async () => {
    if (!configured || busyRef.current) return
    setLoading(true)
    setError(undefined)
    try {
      const next = await signInWithGoogle()
      setSession(next)
      setOutcome(undefined)
      refreshState(next.user.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      throw caught
    } finally {
      setLoading(false)
    }
  }, [configured, refreshState])

  const value = useMemo<CloudContextValue>(() => ({
    configured,
    session,
    loading,
    syncing,
    device,
    checkpoint,
    outcome,
    error,
    signIn,
    signOut: async () => {
      await signOutCloud()
      setSession(null)
      setOutcome(undefined)
      setError(undefined)
      refreshState()
    },
    syncNow,
    keepLocal: () => runResolution('keep'),
    useCloud: () => runResolution('cloud'),
    rebindLocal: () => runResolution('rebind'),
    setAutoSync: (enabled) => {
      setCloudAutoSync(enabled)
      refreshState(session?.user.id)
    },
  }), [configured, session, loading, syncing, device, checkpoint, outcome, error, signIn, syncNow, runResolution, refreshState])

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>
}

export function useCloud() {
  const value = useContext(CloudContext)
  if (!value) throw new Error('useCloud must be used inside CloudProvider')
  return value
}
''')

(cloud / 'CloudSettingsCard.tsx').write_text(r'''import { useState } from 'react'
import { useUiLanguage } from '../uiLanguage'
import { useCloud } from './CloudContext'
import './cloudSettings.css'

function formatTime(iso: string | undefined, zh: boolean) {
  if (!iso) return zh ? '尚未同步' : 'Not synced yet'
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso))
}

export default function CloudSettingsCard() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const cloud = useCloud()
  const [localError, setLocalError] = useState('')
  const user = cloud.session?.user
  const mismatch = Boolean(user && cloud.device.workspaceOwnerUserId && cloud.device.workspaceOwnerUserId !== user.id)
  const conflict = cloud.checkpoint.conflict

  async function run(action: () => Promise<unknown>) {
    setLocalError('')
    try {
      await action()
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const outcomeLabel = !cloud.outcome
    ? ''
    : cloud.outcome.kind === 'created' ? (zh ? '已在你的 Google Drive 建立 PJSDAS 工作区' : 'PJSDAS workspace created in your Google Drive')
      : cloud.outcome.kind === 'pushed' ? (zh ? '本地修改已同步到 Google Drive' : 'Local changes synced to Google Drive')
        : cloud.outcome.kind === 'pulled' ? (zh ? '已从 Google Drive 拉取修改' : 'Changes downloaded from Google Drive')
          : cloud.outcome.kind === 'conflict' ? (zh ? '检测到同步冲突' : 'Sync conflict detected')
            : cloud.outcome.kind === 'account_mismatch' ? (zh ? 'Google 账号与本地工作区不匹配' : 'Google account does not match local workspace')
              : (zh ? '已同步' : 'Synced')

  return (
    <section className="cloud-settings-card">
      <div className="cloud-settings-heading">
        <div>
          <div className="eyebrow">GOOGLE DRIVE SYNC · V1.0</div>
          <h2>{zh ? 'Google 账号与云端同步' : 'Google account & Drive sync'}</h2>
          <p>{zh
            ? 'IndexedDB 仍是即时工作区。启用后，PJSDAS 只把自己的工作区快照保存到你 Google Drive 的隐藏 appDataFolder；PJSDAS 不维护一份自己的用户求职数据库。'
            : 'IndexedDB remains the immediate workspace. When enabled, PJSDAS stores only its workspace snapshot in your Google Drive hidden appDataFolder; PJSDAS does not maintain a separate server-side job-search database.'}</p>
        </div>
        <span className={`cloud-state ${conflict || mismatch ? 'warning' : user ? 'online' : ''}`}>
          {!cloud.configured
            ? (zh ? '未配置' : 'Not configured')
            : mismatch
              ? (zh ? '账号不匹配' : 'Account mismatch')
              : conflict
                ? (zh ? '冲突' : 'Conflict')
                : user
                  ? (zh ? '已连接' : 'Connected')
                  : (zh ? '仅本地' : 'Local only')}
        </span>
      </div>

      {!cloud.configured ? (
        <div className="cloud-setup-note">
          <strong>{zh ? 'Google Drive 同步代码已就绪，但当前部署还没有 OAuth Client ID。' : 'Google Drive sync is ready, but this deployment does not have an OAuth Client ID yet.'}</strong>
          <p>{zh
            ? '在 Google Cloud 启用 Drive API、创建 Web OAuth Client，然后在 GitHub Actions Variables 中设置 VITE_GOOGLE_CLIENT_ID 即可。未配置时所有现有功能继续纯本地运行。'
            : 'Enable the Drive API in Google Cloud, create a Web OAuth client, then set VITE_GOOGLE_CLIENT_ID in GitHub Actions Variables. Until then, every existing feature continues to run locally.'}</p>
        </div>
      ) : !user ? (
        <div className="cloud-auth-row">
          <div><strong>{zh ? '连接你的 Google Drive' : 'Connect your Google Drive'}</strong><p>{zh ? '只申请 openid/profile/email 与 drive.appdata；PJSDAS 不能浏览你的普通 Drive 文件。' : 'Only openid/profile/email and drive.appdata are requested; PJSDAS cannot browse your normal Drive files.'}</p></div>
          <button className="primary-button" disabled={cloud.loading || cloud.syncing} onClick={() => { void run(cloud.signIn) }}>{cloud.loading ? (zh ? '连接中…' : 'Connecting…') : (zh ? '使用 Google 账号连接' : 'Connect Google account')}</button>
        </div>
      ) : (
        <>
          <div className="cloud-account-row">
            <div>
              <span>{zh ? '当前账号' : 'Account'}</span>
              <strong>{user.user_metadata?.full_name || user.email || user.id}</strong>
              {user.email ? <small>{user.email}</small> : null}
            </div>
            <div>
              <span>{zh ? '最后同步' : 'Last sync'}</span>
              <strong>{formatTime(cloud.checkpoint.lastSyncedAt, zh)}</strong>
              <small>{cloud.checkpoint.lastSyncedVersion ? `Drive version ${cloud.checkpoint.lastSyncedVersion}` : '—'}</small>
            </div>
            <div>
              <span>{zh ? '本机' : 'Device'}</span>
              <strong>{cloud.device.deviceId.slice(0, 8)}</strong>
              <small>local-first</small>
            </div>
          </div>

          {mismatch ? (
            <div className="cloud-conflict-box">
              <strong>{zh ? '为避免跨账号上传，自动同步已暂停。' : 'Auto-sync is paused to prevent cross-account uploads.'}</strong>
              <p>{zh
                ? '这个浏览器里的本地工作区已经绑定过另一个 Google 账号。PJSDAS 不会自动把那份求职数据上传到当前账号。'
                : 'The local workspace in this browser is already bound to another Google account. PJSDAS will not upload that job-search data into the current account automatically.'}</p>
              <div>
                <button onClick={() => {
                  if (window.confirm(zh ? '确认把当前本地工作区重新绑定到这个 Google 账号？如果该账号已有 Drive 数据，系统会先进入冲突处理，不会直接覆盖。' : 'Rebind the current local workspace to this Google account? Existing Drive data will trigger conflict handling rather than being overwritten.')) void run(cloud.rebindLocal)
                }}>{zh ? '绑定当前本地工作区' : 'Bind current local workspace'}</button>
                <button className="danger" onClick={() => {
                  if (window.confirm(zh ? '确认用当前 Google 账号的 Drive 工作区替换本机工作区？本机尚未同步的修改会丢失。' : 'Replace this device workspace with the current Google account Drive workspace? Unsynced local changes will be lost.')) void run(cloud.useCloud)
                }}>{zh ? '切换到此账号 Drive 数据' : 'Use this account’s Drive data'}</button>
              </div>
            </div>
          ) : conflict ? (
            <div className="cloud-conflict-box">
              <strong>{zh ? '本机和 Google Drive 在上次同步后都发生了修改。' : 'Both this device and Google Drive changed after the last sync.'}</strong>
              <p>{zh ? `Drive version ${conflict.remoteVersion}，更新时间 ${formatTime(conflict.remoteUpdatedAt, zh)}。系统已停止自动同步，没有覆盖任何一方。` : `Drive version ${conflict.remoteVersion}, updated ${formatTime(conflict.remoteUpdatedAt, zh)}. Auto-sync stopped and neither side was overwritten.`}</p>
              <div>
                <button onClick={() => {
                  if (window.confirm(zh ? '确认以本机数据为准覆盖 Google Drive 中的 PJSDAS 工作区？' : 'Keep this device and overwrite the PJSDAS workspace in Google Drive?')) void run(cloud.keepLocal)
                }}>{zh ? '保留本机' : 'Keep this device'}</button>
                <button className="danger" onClick={() => {
                  if (window.confirm(zh ? '确认以 Google Drive 数据为准替换本机？本机未同步修改会丢失。' : 'Use the Google Drive version and replace local data? Unsynced local changes will be lost.')) void run(cloud.useCloud)
                }}>{zh ? '使用 Google Drive' : 'Use Google Drive'}</button>
              </div>
            </div>
          ) : null}

          <div className="cloud-controls">
            <label><input type="checkbox" checked={cloud.device.autoSync} onChange={(event) => cloud.setAutoSync(event.target.checked)} /> <span>{zh ? '自动同步（本次 Google 授权有效期间约每 2 分钟及重新聚焦时检查）' : 'Auto-sync (roughly every 2 minutes and on refocus while this Google authorization is active)'}</span></label>
            <div>
              <button disabled={cloud.syncing || mismatch || Boolean(conflict)} onClick={() => { void run(async () => cloud.syncNow()) }}>{cloud.syncing ? (zh ? '同步中…' : 'Syncing…') : (zh ? '立即同步' : 'Sync now')}</button>
              <button onClick={() => { void run(cloud.signOut) }}>{zh ? '断开 Google' : 'Disconnect Google'}</button>
            </div>
          </div>
          {outcomeLabel ? <div className="cloud-result">{outcomeLabel}</div> : null}
        </>
      )}

      {(localError || cloud.error || cloud.checkpoint.lastError) ? <div className="cloud-error">{localError || cloud.error || cloud.checkpoint.lastError}</div> : null}
      <small className="cloud-security-note">{zh ? 'Google Access Token 只保存在当前页面内存中，不写入 IndexedDB 或 localStorage；授权过期只会暂停云同步，本地 PJSDAS 继续可用。' : 'The Google access token is kept only in current-page memory, never IndexedDB or localStorage. Expired authorization pauses cloud sync while local PJSDAS remains usable.'}</small>
    </section>
  )
}
''')

(root / 'tests' / 'cloudSyncLogic.test.ts').write_text(r'''import { describe, expect, it } from 'vitest'
import { decideSyncAction } from '../src/cloud/syncLogic'

describe('local-first Google Drive sync decisions', () => {
  it('creates Drive workspace when no remote file exists', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'local', localEmpty: false, remote: null })).toBe('create_remote')
  })

  it('pulls an existing Drive workspace into a new empty device', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'empty', localEmpty: true, remote: { version: '4', fingerprint: 'remote' } })).toBe('pull_remote')
  })

  it('fails closed on first sync when both local and Drive already contain different data', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'local', localEmpty: false, remote: { version: '4', fingerprint: 'remote' } })).toBe('conflict')
  })

  it('pushes when only local changed since the common Drive version', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedVersion: '4', lastSyncedFingerprint: 'base' },
      localFingerprint: 'local-new',
      localEmpty: false,
      remote: { version: '4', fingerprint: 'base' },
    })).toBe('push_local')
  })

  it('pulls when only Drive changed since the common version', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedVersion: '4', lastSyncedFingerprint: 'base' },
      localFingerprint: 'base',
      localEmpty: false,
      remote: { version: '5', fingerprint: 'remote-new' },
    })).toBe('pull_remote')
  })

  it('stops on concurrent local and Drive changes', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedVersion: '4', lastSyncedFingerprint: 'base' },
      localFingerprint: 'local-new',
      localEmpty: false,
      remote: { version: '5', fingerprint: 'remote-new' },
    })).toBe('conflict')
  })

  it('adopts an equal Drive fingerprint without rewriting either side', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'same', localEmpty: false, remote: { version: '8', fingerprint: 'same' } })).toBe('adopt_equal')
  })
})
''')

(root / 'tests' / 'driveEnvelope.test.ts').write_text(r'''import { describe, expect, it } from 'vitest'
import { createSnapshot } from '../src/snapshot'
import { createDriveWorkspaceEnvelope, parseDriveWorkspaceEnvelope } from '../src/cloud/driveEnvelope'

const empty = createSnapshot({
  opportunities: [],
  processes: [],
  processEvents: [],
  actions: [],
  prep: [],
  applicationGroups: [],
}, '2026-09-11T00:00:00.000Z')

describe('Google Drive workspace envelope', () => {
  it('round-trips normalized workspace metadata', () => {
    const envelope = createDriveWorkspaceEnvelope({ fingerprint: 'abc', deviceId: 'device-1', snapshot: empty, updatedAt: '2026-09-11T01:00:00.000Z' })
    expect(parseDriveWorkspaceEnvelope(envelope)).toEqual(envelope)
  })

  it('rejects unrelated JSON files', () => {
    expect(() => parseDriveWorkspaceEnvelope({ hello: 'world' })).toThrow(/版本|格式/)
  })
})
''')

(root / '.env.example').write_text('VITE_GOOGLE_CLIENT_ID=REPLACE_ME.apps.googleusercontent.com\n')

(root / 'docs' / 'CLOUD_SETUP.md').write_text(r'''# PJSDAS v1.0 Google Drive Sync Setup

PJSDAS remains fully usable without cloud configuration. Cloud mode uses Google Identity Services and the Google Drive API to store one hidden PJSDAS workspace file inside the user's own Drive `appDataFolder`.

There is no PJSDAS cloud database in v1.0. IndexedDB remains the immediate workspace used by the UI.

## 1. Create or choose a Google Cloud project

Open Google Cloud Console, create a project for PJSDAS (or choose an existing project dedicated to it), and enable **Google Drive API**.

## 2. Configure the OAuth consent screen

Configure Google Auth / OAuth consent for the project. During development or testing, add the Google accounts that should be allowed to test the app if the consent screen is still in testing mode.

PJSDAS requests only:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/drive.appdata`

`drive.appdata` lets PJSDAS view and manage only its own application data in the hidden Drive application-data folder. It does not grant PJSDAS permission to browse the user's ordinary My Drive files.

## 3. Create a Web OAuth client

Create an OAuth 2.0 Client ID of type **Web application**.

For the public GitHub Pages deployment, add this Authorized JavaScript origin:

`https://haohongfei2001-png.github.io`

For local development, add the local Vite origin that you actually use, for example `http://localhost:5173`.

The v1.0 implementation uses the Google Identity Services token model in a popup and does not require a PJSDAS backend or a redirect endpoint.

Copy the resulting Client ID. It normally ends in `.apps.googleusercontent.com`.

## 4. Configure the GitHub Pages build

In the GitHub repository, add one Actions **Variable**:

- `VITE_GOOGLE_CLIENT_ID`

Set it to the Web OAuth Client ID from the previous step, then re-run the GitHub Pages deployment.

For local development, copy `.env.example` to `.env.local` and set the same value.

## 5. Where the data lives

PJSDAS creates a hidden file named:

`pjsdas-workspace.json`

inside the user's Google Drive `appDataFolder`. The file contains the validated PJSDAS local snapshot plus a fingerprint and device metadata used for conflict detection.

The user does not need to manually manage this file in Drive, and PJSDAS cannot use the `drive.appdata` permission to browse normal Drive documents.

## 6. Local-first and conflict semantics

- IndexedDB is the immediate source used by the UI.
- The Drive copy is a synchronization/recovery copy, not the live database.
- PJSDAS computes a SHA-256 fingerprint of normalized workspace data.
- Google Drive's monotonically increasing file `version` is stored as the remote checkpoint.
- If only local changed, PJSDAS uploads the current snapshot.
- If only Drive changed, PJSDAS validates and restores that snapshot locally.
- If both changed after the last common checkpoint, sync stops and asks the user which side to keep.
- A browser workspace is bound to the first Google account it syncs with. Connecting another account does not silently upload the existing local data.

Before an existing Drive file is updated, PJSDAS re-reads its Drive `version`. If it changed, the write is aborted and handled as a conflict. This is a fail-closed client-side guard rather than a claim of server-side transactional locking.

## 7. Token and privacy boundary

The Google OAuth access token is kept only in current-page memory. PJSDAS does not write it to IndexedDB or `localStorage` and has no refresh-token service in v1.0.

Therefore a full page reload or an expired token can require the user to connect Google again. This affects cloud synchronization only; the complete local application continues to work offline/local-first.

Do not add a client secret, service-account key, or other server credential to GitHub Pages or Vite environment variables.
''')

readme = root / 'README.md'
text = readme.read_text()
marker = '## v1.0 account and cloud sync'
if marker not in text:
    raise SystemExit('README v1.0 marker missing')
text = text.split(marker, 1)[0].rstrip() + r'''

## v1.0 account and Google Drive sync

v1.0 keeps PJSDAS local-first. IndexedDB is still the immediate workspace used by the UI, and the application remains fully functional without cloud configuration, while offline, or after Google authorization expires.

Optional synchronization uses **Google Identity Services + Google Drive `appDataFolder`** rather than a PJSDAS-owned user database. After the user explicitly connects a Google account, PJSDAS can create one hidden `pjsdas-workspace.json` file in that account's application-data folder. The requested `drive.appdata` permission is limited to PJSDAS application data and does not allow the app to browse ordinary Drive files.

The Drive file stores a validated PJSDAS snapshot plus a SHA-256 workspace fingerprint and device metadata. Google Drive's monotonically increasing file `version` is the remote synchronization checkpoint. Only-local changes push, only-Drive changes pull, and concurrent local/Drive changes fail closed into an explicit conflict instead of silently using last-write-wins.

The Google access token is kept only in page memory and is never persisted to IndexedDB or localStorage. v1.0 has no refresh-token backend, so a reload or expired authorization can require the user to reconnect Google; local PJSDAS functionality never depends on that authorization.

The first successful sync binds the current browser workspace to that Google account. Connecting a different Google account pauses synchronization rather than silently uploading another user's local job-search data.

See `docs/CLOUD_SETUP.md` for the one-time Google Cloud OAuth and Drive API setup. The public build reads only `VITE_GOOGLE_CLIENT_ID`; no OAuth client secret or server credential belongs in the frontend.
'''
readme.write_text(text)

supabase_schema = root / 'supabase' / 'schema.sql'
if supabase_schema.exists():
    supabase_schema.unlink()
