from pathlib import Path

# ---------- cloud config ----------
cloud_dir = Path('src/cloud')
cloud_dir.mkdir(parents=True, exist_ok=True)

(cloud_dir / 'cloudConfig.ts').write_text(r'''export interface CloudConfig {
  url: string
  publishableKey: string
}

export function readCloudConfig(): CloudConfig | null {
  const env = import.meta.env as Record<string, string | undefined>
  const url = (env.VITE_SUPABASE_URL ?? '').trim()
  const publishableKey = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !publishableKey) return null
  return { url, publishableKey }
}

export function cloudRedirectUrl() {
  if (typeof window === 'undefined') return ''
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString()
}
''')

(cloud_dir / 'cloudClient.ts').write_text(r'''import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { cloudRedirectUrl, readCloudConfig } from './cloudConfig'

let singleton: SupabaseClient | null | undefined

export function getCloudClient() {
  if (singleton !== undefined) return singleton
  const config = readCloudConfig()
  if (!config) {
    singleton = null
    return null
  }
  singleton = createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  return singleton
}

export async function getCloudSession(): Promise<Session | null> {
  const client = getCloudClient()
  if (!client) return null
  const { data, error } = await client.auth.getSession()
  if (error) throw error
  return data.session
}

export async function signInWithGoogle() {
  const client = getCloudClient()
  if (!client) throw new Error('云端尚未配置。')
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: cloudRedirectUrl() },
  })
  if (error) throw error
}

export async function signOutCloud() {
  const client = getCloudClient()
  if (!client) return
  const { error } = await client.auth.signOut()
  if (error) throw error
}
''')

# ---------- device-local sync checkpoint ----------
(cloud_dir / 'syncState.ts').write_text(r'''export interface CloudConflictState {
  remoteRevision: number
  remoteFingerprint: string
  remoteUpdatedAt: string
  remoteDeviceId?: string
}

export interface AccountSyncCheckpoint {
  lastSyncedRevision?: number
  lastSyncedFingerprint?: string
  lastSyncedAt?: string
  lastError?: string
  conflict?: CloudConflictState
}

export interface CloudDeviceState {
  version: 1
  deviceId: string
  autoSync: boolean
  workspaceOwnerUserId?: string
  accounts: Record<string, AccountSyncCheckpoint>
}

const STORAGE_KEY = 'pjsdas-cloud-sync-state-v1'

function randomDeviceId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function freshState(): CloudDeviceState {
  return { version: 1, deviceId: randomDeviceId(), autoSync: true, accounts: {} }
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
    if (parsed.version !== 1 || !parsed.deviceId || typeof parsed.autoSync !== 'boolean') throw new Error('invalid')
    return {
      version: 1,
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

# ---------- pure sync policy ----------
(cloud_dir / 'syncLogic.ts').write_text(r'''export interface SyncCheckpointInput {
  lastSyncedRevision?: number
  lastSyncedFingerprint?: string
}

export interface RemoteWorkspaceVersion {
  revision: number
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

  if (checkpoint.lastSyncedRevision === undefined || !checkpoint.lastSyncedFingerprint) {
    return localEmpty ? 'pull_remote' : 'conflict'
  }

  const localChanged = localFingerprint !== checkpoint.lastSyncedFingerprint
  const remoteChanged = remote.revision !== checkpoint.lastSyncedRevision ||
    remote.fingerprint !== checkpoint.lastSyncedFingerprint

  if (!localChanged && !remoteChanged) return 'noop'
  if (localChanged && !remoteChanged) return 'push_local'
  if (!localChanged && remoteChanged) return 'pull_remote'
  return 'conflict'
}
''')

# ---------- fingerprint ----------
(cloud_dir / 'workspaceFingerprint.ts').write_text(r'''import { DEFAULT_DECISION_RULES } from '../decisionRules'
import type { PJSDASSnapshot } from '../snapshot'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) next[key] = canonical(record[key])
    }
    return next
  }
  return value
}

export function canonicalWorkspaceJson(snapshot: PJSDASSnapshot) {
  return JSON.stringify(canonical(snapshot.data))
}

export async function fingerprintWorkspace(snapshot: PJSDASSnapshot) {
  const bytes = new TextEncoder().encode(canonicalWorkspaceJson(snapshot))
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持安全的工作区指纹计算。')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function rulesAreDefault(snapshot: PJSDASSnapshot) {
  const rules = snapshot.data.decisionRules
  if (!rules) return true
  const a = { ...rules, updatedAt: '', weights: { ...rules.weights } }
  const b = { ...DEFAULT_DECISION_RULES, updatedAt: '', weights: { ...DEFAULT_DECISION_RULES.weights } }
  return JSON.stringify(a) === JSON.stringify(b)
}

export function workspaceIsEffectivelyEmpty(snapshot: PJSDASSnapshot) {
  const data = snapshot.data
  const meaningfulTimeline = (data.timeline ?? []).some((item) => item.kind !== 'baseline_backfill' && item.source !== 'system')
  return data.opportunities.length === 0 &&
    data.processes.length === 0 &&
    data.processEvents.length === 0 &&
    data.actions.length === 0 &&
    data.prep.length === 0 &&
    data.applicationGroups.length === 0 &&
    (data.changeSets ?? []).length === 0 &&
    !meaningfulTimeline &&
    !data.meta &&
    rulesAreDefault(snapshot)
}
''')

# ---------- remote repository ----------
(cloud_dir / 'cloudRepository.ts').write_text(r'''import type { PJSDASSnapshot } from '../snapshot'
import { getCloudClient } from './cloudClient'

export interface RemoteWorkspaceRow {
  userId: string
  revision: number
  schemaVersion: number
  fingerprint: string
  snapshot: PJSDASSnapshot
  updatedByDevice: string
  updatedAt: string
}

type RawRemoteRow = {
  user_id: string
  revision: number | string
  schema_version: number | string
  fingerprint: string
  snapshot: PJSDASSnapshot
  updated_by_device: string
  updated_at: string
}

function client() {
  const value = getCloudClient()
  if (!value) throw new Error('云端尚未配置。')
  return value
}

function normalize(row: RawRemoteRow): RemoteWorkspaceRow {
  return {
    userId: row.user_id,
    revision: Number(row.revision),
    schemaVersion: Number(row.schema_version),
    fingerprint: row.fingerprint,
    snapshot: row.snapshot,
    updatedByDevice: row.updated_by_device,
    updatedAt: row.updated_at,
  }
}

const selectFields = 'user_id,revision,schema_version,fingerprint,snapshot,updated_by_device,updated_at'

export async function fetchRemoteWorkspace(userId: string): Promise<RemoteWorkspaceRow | null> {
  const { data, error } = await client()
    .from('pjsdas_workspaces')
    .select(selectFields)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`读取云端工作区失败：${error.message}`)
  return data ? normalize(data as RawRemoteRow) : null
}

export async function createRemoteWorkspace(input: {
  userId: string
  fingerprint: string
  snapshot: PJSDASSnapshot
  deviceId: string
}): Promise<RemoteWorkspaceRow | null> {
  const now = new Date().toISOString()
  const { data, error } = await client()
    .from('pjsdas_workspaces')
    .insert({
      user_id: input.userId,
      revision: 1,
      schema_version: 1,
      fingerprint: input.fingerprint,
      snapshot: input.snapshot,
      updated_by_device: input.deviceId,
      updated_at: now,
    })
    .select(selectFields)
    .maybeSingle()
  if (error) {
    if (error.code === '23505') return null
    throw new Error(`创建云端工作区失败：${error.message}`)
  }
  return data ? normalize(data as RawRemoteRow) : null
}

export async function updateRemoteWorkspace(input: {
  userId: string
  expectedRevision: number
  fingerprint: string
  snapshot: PJSDASSnapshot
  deviceId: string
}): Promise<RemoteWorkspaceRow | null> {
  const nextRevision = input.expectedRevision + 1
  const { data, error } = await client()
    .from('pjsdas_workspaces')
    .update({
      revision: nextRevision,
      schema_version: 1,
      fingerprint: input.fingerprint,
      snapshot: input.snapshot,
      updated_by_device: input.deviceId,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', input.userId)
    .eq('revision', input.expectedRevision)
    .select(selectFields)
    .maybeSingle()
  if (error) throw new Error(`写入云端工作区失败：${error.message}`)
  return data ? normalize(data as RawRemoteRow) : null
}
''')

# ---------- sync orchestrator ----------
(cloud_dir / 'cloudSync.ts').write_text(r'''import { exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../db'
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
  revision?: number
  remoteUpdatedAt?: string
}

async function verifyRemote(row: RemoteWorkspaceRow) {
  if (row.schemaVersion !== 1) throw new Error(`不支持云端工作区 schema v${row.schemaVersion}。`)
  validateSnapshot(row.snapshot)
  const fingerprint = await fingerprintWorkspace(row.snapshot)
  if (fingerprint !== row.fingerprint) throw new Error('云端工作区指纹校验失败，已停止同步。')
  return row
}

function conflictFromRemote(row: RemoteWorkspaceRow): CloudConflictState {
  return {
    remoteRevision: row.revision,
    remoteFingerprint: row.fingerprint,
    remoteUpdatedAt: row.updatedAt,
    remoteDeviceId: row.updatedByDevice,
  }
}

function markSynced(userId: string, row: RemoteWorkspaceRow) {
  patchAccountCheckpoint(userId, {
    lastSyncedRevision: row.revision,
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
      remote: remote ? { revision: remote.revision, fingerprint: remote.fingerprint } : null,
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
        if (!raced) throw new Error('云端工作区创建冲突，但无法读取最新版本。')
        const verified = await verifyRemote(raced)
        markConflict(userId, verified)
        return { kind: 'conflict', revision: verified.revision, remoteUpdatedAt: verified.updatedAt }
      }
      markSynced(userId, created)
      return { kind: 'created', revision: created.revision, remoteUpdatedAt: created.updatedAt }
    }

    if (!remote) throw new Error('同步状态异常：预期存在云端工作区。')

    if (decision === 'push_local') {
      const updated = await updateRemoteWorkspace({
        userId,
        expectedRevision: remote.revision,
        fingerprint: localFingerprint,
        snapshot: local,
        deviceId: device.deviceId,
      })
      if (!updated) {
        const latest = await fetchRemoteWorkspace(userId)
        if (!latest) throw new Error('云端工作区在同步过程中消失。')
        const verified = await verifyRemote(latest)
        markConflict(userId, verified)
        return { kind: 'conflict', revision: verified.revision, remoteUpdatedAt: verified.updatedAt }
      }
      markSynced(userId, updated)
      return { kind: 'pushed', revision: updated.revision, remoteUpdatedAt: updated.updatedAt }
    }

    if (decision === 'pull_remote') {
      await replaceLocalSnapshotFromCloud(remote.snapshot)
      markSynced(userId, remote)
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
      return { kind: 'pulled', revision: remote.revision, remoteUpdatedAt: remote.updatedAt }
    }

    if (decision === 'conflict') {
      markConflict(userId, remote)
      return { kind: 'conflict', revision: remote.revision, remoteUpdatedAt: remote.updatedAt }
    }

    markSynced(userId, remote)
    return { kind: 'synced', revision: remote.revision, remoteUpdatedAt: remote.updatedAt }
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
    expectedRevision: remote.revision,
    fingerprint,
    snapshot: local,
    deviceId: device.deviceId,
  })
  if (!updated) {
    const latest = await fetchRemoteWorkspace(userId)
    if (!latest) throw new Error('云端工作区在冲突解决过程中消失。')
    const verified = await verifyRemote(latest)
    markConflict(userId, verified)
    return { kind: 'conflict', revision: verified.revision, remoteUpdatedAt: verified.updatedAt }
  }
  bindLocalWorkspaceToUser(userId)
  markSynced(userId, updated)
  return { kind: 'pushed', revision: updated.revision, remoteUpdatedAt: updated.updatedAt }
}

export async function resolveConflictUseCloud(userId: string): Promise<CloudSyncOutcome> {
  const remoteRaw = await fetchRemoteWorkspace(userId)
  if (!remoteRaw) throw new Error('此账号还没有云端工作区。')
  const remote = await verifyRemote(remoteRaw)
  await replaceLocalSnapshotFromCloud(remote.snapshot)
  bindLocalWorkspaceToUser(userId, true)
  markSynced(userId, remote)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
  return { kind: 'pulled', revision: remote.revision, remoteUpdatedAt: remote.updatedAt }
}

export async function rebindCurrentLocalWorkspace(userId: string) {
  bindLocalWorkspaceToUser(userId, true)
  return runCloudSync(userId)
}
''')

# ---------- React cloud context ----------
(cloud_dir / 'CloudContext.tsx').write_text(r'''import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { getCloudClient, getCloudSession, signInWithGoogle, signOutCloud } from './cloudClient'
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
  session: Session | null
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
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(configured)
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

  useEffect(() => {
    if (!configured) return
    let active = true
    const client = getCloudClient()
    if (!client) return
    getCloudSession()
      .then((next) => {
        if (!active) return
        setSession(next)
        refreshState(next?.user.id)
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => active && setLoading(false))

    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return
      setSession(nextSession)
      refreshState(nextSession?.user.id)
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [configured, refreshState])

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
      throw caught
    } finally {
      busyRef.current = false
      setSyncing(false)
    }
  }, [configured, session?.user.id, refreshState])

  useEffect(() => {
    const userId = session?.user.id
    if (!configured || !userId || !device.autoSync || checkpoint.conflict) return
    const ownerMismatch = Boolean(device.workspaceOwnerUserId && device.workspaceOwnerUserId !== userId)
    if (ownerMismatch) return

    const initial = window.setTimeout(() => { void syncNow().catch(() => undefined) }, 900)
    const interval = window.setInterval(() => { void syncNow().catch(() => undefined) }, 60_000)
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
      throw caught
    } finally {
      busyRef.current = false
      setSyncing(false)
    }
  }, [session?.user.id, refreshState])

  const value = useMemo<CloudContextValue>(() => ({
    configured,
    session,
    loading,
    syncing,
    device,
    checkpoint,
    outcome,
    error,
    signIn: signInWithGoogle,
    signOut: async () => {
      await signOutCloud()
      setSession(null)
      setOutcome(undefined)
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
  }), [configured, session, loading, syncing, device, checkpoint, outcome, error, syncNow, runResolution, refreshState])

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>
}

export function useCloud() {
  const value = useContext(CloudContext)
  if (!value) throw new Error('useCloud must be used inside CloudProvider')
  return value
}
''')

# ---------- cloud settings UI ----------
(cloud_dir / 'CloudSettingsCard.tsx').write_text(r'''import { useState } from 'react'
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
    : cloud.outcome.kind === 'created' ? (zh ? '已创建云端工作区' : 'Cloud workspace created')
      : cloud.outcome.kind === 'pushed' ? (zh ? '本地修改已上传' : 'Local changes uploaded')
        : cloud.outcome.kind === 'pulled' ? (zh ? '已拉取云端修改' : 'Cloud changes downloaded')
          : cloud.outcome.kind === 'conflict' ? (zh ? '检测到同步冲突' : 'Sync conflict detected')
            : cloud.outcome.kind === 'account_mismatch' ? (zh ? '账号与本地工作区不匹配' : 'Account does not match local workspace')
              : (zh ? '已同步' : 'Synced')

  return (
    <section className="cloud-settings-card">
      <div className="cloud-settings-heading">
        <div>
          <div className="eyebrow">ACCOUNT & CLOUD · V1.0</div>
          <h2>{zh ? '账号与云端同步' : 'Account & cloud sync'}</h2>
          <p>{zh
            ? 'IndexedDB 仍是即时工作区。登录后云端保存账号隔离的加密传输快照，并用 revision 检测多设备冲突；系统不会静默覆盖双端修改。'
            : 'IndexedDB remains the immediate workspace. After sign-in, the cloud stores an account-isolated snapshot over encrypted transport and uses revisions to detect multi-device conflicts; concurrent edits are never silently overwritten.'}</p>
        </div>
        <span className={`cloud-state ${conflict || mismatch ? 'warning' : user ? 'online' : ''}`}>
          {!cloud.configured
            ? (zh ? '未配置' : 'Not configured')
            : mismatch
              ? (zh ? '账号不匹配' : 'Account mismatch')
              : conflict
                ? (zh ? '冲突' : 'Conflict')
                : user
                  ? (zh ? '已登录' : 'Signed in')
                  : (zh ? '仅本地' : 'Local only')}
        </span>
      </div>

      {!cloud.configured ? (
        <div className="cloud-setup-note">
          <strong>{zh ? '云端代码已就绪，但当前部署没有连接云项目。' : 'Cloud code is ready, but this deployment is not connected to a cloud project.'}</strong>
          <p>{zh
            ? '创建 Supabase 项目并配置 Google OAuth 后，在 GitHub Actions Variables 中设置 VITE_SUPABASE_URL 和 VITE_SUPABASE_PUBLISHABLE_KEY 即可启用。未配置时所有现有功能继续纯本地运行。'
            : 'Create a Supabase project, configure Google OAuth, then set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY as GitHub Actions variables. Until then, every existing feature continues to run locally.'}</p>
        </div>
      ) : !user ? (
        <div className="cloud-auth-row">
          <div><strong>{zh ? '使用 Google 账号登录' : 'Sign in with Google'}</strong><p>{zh ? '登录只用于识别你的 PJSDAS 云工作区。' : 'Sign-in is used to identify your private PJSDAS cloud workspace.'}</p></div>
          <button className="primary-button" disabled={cloud.loading || cloud.syncing} onClick={() => { void run(cloud.signIn) }}>{zh ? '使用 Google 登录' : 'Sign in with Google'}</button>
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
              <small>{cloud.checkpoint.lastSyncedRevision ? `revision ${cloud.checkpoint.lastSyncedRevision}` : '—'}</small>
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
                ? '这个浏览器里的本地工作区已经绑定过另一个账号。PJSDAS 不会自动把那份求职数据上传到当前账号。'
                : 'The local workspace in this browser is already bound to another account. PJSDAS will not upload that job-search data into the current account automatically.'}</p>
              <div>
                <button onClick={() => {
                  if (window.confirm(zh ? '确认把当前本地工作区重新绑定到这个账号？如果此账号已有云端数据，系统会先进入冲突处理，不会直接覆盖。' : 'Rebind the current local workspace to this account? Existing cloud data will trigger conflict handling rather than being overwritten.')) void run(cloud.rebindLocal)
                }}>{zh ? '绑定当前本地工作区' : 'Bind current local workspace'}</button>
                <button className="danger" onClick={() => {
                  if (window.confirm(zh ? '确认用当前账号的云端工作区替换本机工作区？本机尚未同步的修改会丢失。' : 'Replace this device workspace with this account’s cloud workspace? Unsynced local changes will be lost.')) void run(cloud.useCloud)
                }}>{zh ? '切换到此账号云端数据' : 'Use this account’s cloud data'}</button>
              </div>
            </div>
          ) : conflict ? (
            <div className="cloud-conflict-box">
              <strong>{zh ? '本机和云端在上次同步后都发生了修改。' : 'Both this device and the cloud changed after the last sync.'}</strong>
              <p>{zh ? `云端 revision ${conflict.remoteRevision}，更新时间 ${formatTime(conflict.remoteUpdatedAt, zh)}。系统已停止自动同步，没有覆盖任何一方。` : `Cloud revision ${conflict.remoteRevision}, updated ${formatTime(conflict.remoteUpdatedAt, zh)}. Auto-sync stopped and neither side was overwritten.`}</p>
              <div>
                <button onClick={() => {
                  if (window.confirm(zh ? '确认以本机数据为准覆盖云端？' : 'Keep this device and overwrite the cloud version?')) void run(cloud.keepLocal)
                }}>{zh ? '保留本机' : 'Keep this device'}</button>
                <button className="danger" onClick={() => {
                  if (window.confirm(zh ? '确认以云端数据为准替换本机？本机未同步修改会丢失。' : 'Use the cloud version and replace local data? Unsynced local changes will be lost.')) void run(cloud.useCloud)
                }}>{zh ? '使用云端' : 'Use cloud'}</button>
              </div>
            </div>
          ) : null}

          <div className="cloud-controls">
            <label><input type="checkbox" checked={cloud.device.autoSync} onChange={(event) => cloud.setAutoSync(event.target.checked)} /> <span>{zh ? '自动同步（约每分钟及重新聚焦时检查）' : 'Auto-sync (roughly every minute and on refocus)'}</span></label>
            <div>
              <button disabled={cloud.syncing || mismatch || Boolean(conflict)} onClick={() => { void run(async () => cloud.syncNow()) }}>{cloud.syncing ? (zh ? '同步中…' : 'Syncing…') : (zh ? '立即同步' : 'Sync now')}</button>
              <button onClick={() => { void run(cloud.signOut) }}>{zh ? '退出登录' : 'Sign out'}</button>
            </div>
          </div>
          {outcomeLabel ? <div className="cloud-result">{outcomeLabel}</div> : null}
        </>
      )}

      {(localError || cloud.error || cloud.checkpoint.lastError) ? <div className="cloud-error">{localError || cloud.error || cloud.checkpoint.lastError}</div> : null}
      <small className="cloud-security-note">{zh ? '云端只使用浏览器可公开的 Supabase Publishable Key；不要把 service_role key 放进前端或 GitHub Pages。' : 'The browser uses only the public Supabase Publishable Key. Never place a service_role key in the frontend or GitHub Pages.'}</small>
    </section>
  )
}
''')

(cloud_dir / 'cloudSettings.css').write_text(r'''.cloud-settings-card { margin:18px 0; padding:22px; border:1px solid rgba(49,46,42,.12); border-radius:20px; background:rgba(255,255,255,.72); box-shadow:0 8px 28px rgba(48,43,36,.025); }
.cloud-settings-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; }
.cloud-settings-heading h2 { margin:5px 0 7px; font-size:20px; letter-spacing:-.025em; }
.cloud-settings-heading p { max-width:760px; margin:0; color:#777169; font-size:12.5px; line-height:1.65; }
.cloud-state { flex:0 0 auto; border:1px solid rgba(68,65,59,.12); border-radius:999px; padding:6px 10px; background:#f3f0e9; color:#817c74; font-size:11px; font-weight:700; }
.cloud-state.online { background:#edf2ec; color:#506354; }
.cloud-state.warning { background:#f8eee5; color:#8a5d47; }
.cloud-setup-note,.cloud-auth-row,.cloud-conflict-box { margin-top:18px; border:1px solid rgba(68,65,59,.1); border-radius:15px; padding:16px; background:#faf8f3; }
.cloud-setup-note strong,.cloud-auth-row strong,.cloud-conflict-box strong { color:#34322e; font-size:13px; }
.cloud-setup-note p,.cloud-auth-row p,.cloud-conflict-box p { margin:6px 0 0; color:#7d776e; font-size:12px; line-height:1.65; }
.cloud-auth-row { display:flex; align-items:center; justify-content:space-between; gap:20px; }
.cloud-account-row { display:grid; grid-template-columns:1.5fr 1fr .7fr; gap:10px; margin-top:18px; }
.cloud-account-row > div { display:grid; gap:3px; padding:14px; border:1px solid rgba(68,65,59,.09); border-radius:14px; background:#fbfaf7; }
.cloud-account-row span { color:#989188; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; }
.cloud-account-row strong { overflow:hidden; color:#34322e; font-size:12.5px; text-overflow:ellipsis; white-space:nowrap; }
.cloud-account-row small { overflow:hidden; color:#8a847c; font-size:10.5px; text-overflow:ellipsis; white-space:nowrap; }
.cloud-conflict-box { background:#fcf3eb; border-color:rgba(142,91,61,.2); }
.cloud-conflict-box > div { display:flex; gap:8px; margin-top:12px; }
.cloud-conflict-box button,.cloud-controls button { min-height:34px; border:1px solid rgba(68,65,59,.14); border-radius:10px; padding:0 12px; background:#fffdf9; color:#504d47; font:inherit; font-size:11.5px; cursor:pointer; }
.cloud-conflict-box button.danger { border-color:rgba(133,82,56,.18); background:#f3e3d8; color:#855238; }
.cloud-controls { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-top:15px; }
.cloud-controls label { display:flex; align-items:center; gap:7px; color:#68635c; font-size:11.5px; }
.cloud-controls > div { display:flex; gap:8px; }
.cloud-controls button:disabled,.cloud-conflict-box button:disabled { opacity:.5; cursor:not-allowed; }
.cloud-result { margin-top:10px; color:#536657; font-size:11.5px; }
.cloud-error { margin-top:10px; border-radius:10px; padding:9px 11px; background:#f6e8e2; color:#8e4e3f; font-size:11.5px; }
.cloud-security-note { display:block; margin-top:14px; color:#9a948c; font-size:10.5px; line-height:1.5; }
@media (max-width:760px) { .cloud-settings-heading,.cloud-auth-row,.cloud-controls { align-items:stretch; flex-direction:column; } .cloud-account-row { grid-template-columns:1fr; } .cloud-controls > div { width:100%; } .cloud-controls button { flex:1; } }
''')

# ---------- DB: exact cloud replacement without backup-side effects ----------
p = Path('src/db.ts')
s = p.read_text()
anchor = "export async function restoreLocalSnapshot(snapshot: PJSDASSnapshot) {\n"
if anchor not in s:
    raise SystemExit('restoreLocalSnapshot anchor missing')
insert = r'''export async function replaceLocalSnapshotFromCloud(snapshot: PJSDASSnapshot) {
  validateSnapshot(snapshot)

  const db = await dbPromise
  const tx = db.transaction([...DATA_STORES], 'readwrite')
  await Promise.all(DATA_STORES.map((storeName) => tx.objectStore(storeName).clear()))

  for (const item of snapshot.data.opportunities) await tx.objectStore('opportunities').put(item)
  for (const item of snapshot.data.processes) await tx.objectStore('processes').put(item)
  for (const item of snapshot.data.processEvents) await tx.objectStore('processEvents').put(item)
  for (const item of snapshot.data.actions) await tx.objectStore('actions').put(item)
  for (const item of snapshot.data.prep) await tx.objectStore('prep').put(item)
  for (const item of snapshot.data.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  await tx.objectStore('decisionRules').put(snapshot.data.decisionRules ?? createDefaultDecisionRules())
  for (const item of snapshot.data.timeline ?? []) await tx.objectStore('timeline').put(item)
  for (const item of snapshot.data.changeSets ?? []) await tx.objectStore('changeSets').put(item)
  if (snapshot.data.meta) await tx.objectStore('meta').put(snapshot.data.meta)
  await tx.done
}

'''
s = s.replace(anchor, insert + anchor, 1)
p.write_text(s)

# ---------- main: cloud provider + refresh after remote pull ----------
p = Path('src/main.tsx')
s = p.read_text()
s = s.replace("import { StrictMode, useState } from 'react'", "import { StrictMode, useEffect, useState } from 'react'", 1)
s = s.replace("import { UiLanguageProvider } from './uiLanguage'\n", "import { UiLanguageProvider } from './uiLanguage'\nimport { CloudProvider } from './cloud/CloudContext'\n", 1)
old = """function Root() {
  const [revision, setRevision] = useState(0)
  const refresh = () => setRevision((value) => value + 1)
  return (
"""
new = """function Root() {
  const [revision, setRevision] = useState(0)
  const refresh = () => setRevision((value) => value + 1)
  useEffect(() => {
    const handleWorkspaceReplace = () => setRevision((value) => value + 1)
    window.addEventListener('pjsdas:workspace-replaced', handleWorkspaceReplace)
    return () => window.removeEventListener('pjsdas:workspace-replaced', handleWorkspaceReplace)
  }, [])
  return (
"""
if old not in s:
    raise SystemExit('Root anchor missing')
s = s.replace(old, new, 1)
old = """    <UiLanguageProvider>
      <Root />
    </UiLanguageProvider>
"""
new = """    <UiLanguageProvider>
      <CloudProvider>
        <Root />
      </CloudProvider>
    </UiLanguageProvider>
"""
if old not in s:
    raise SystemExit('provider anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

# ---------- Settings UI ----------
p = Path('src/AppV5.tsx')
s = p.read_text()
s = s.replace("import TimelineView from './TimelineView'\n", "import TimelineView from './TimelineView'\nimport CloudSettingsCard from './cloud/CloudSettingsCard'\n", 1)
s = s.replace("<span>Local-first · v0.8</span>", "<span>Local-first · v1.0</span>", 1)
anchor = """      <div className="ui-language-card">
        <div>
          <strong>{t('settings.languageTitle')}</strong>
          <p>{t('settings.languageText')}</p>
        </div>
        <LanguageSwitch />
      </div>

"""
if anchor not in s:
    raise SystemExit('Settings language card anchor missing')
s = s.replace(anchor, anchor + "      <CloudSettingsCard />\n\n", 1)
p.write_text(s)

# ---------- language subtitle ----------
p = Path('src/uiLanguage.tsx')
s = p.read_text()
old = "  'settings.subtitle': ['Excel 用于初始导入和恢复；日常更新优先通过自然语言进展与流程通知完成。', 'Use Excel for initial import and recovery; maintain day-to-day state through progress updates and process notifications.'],\n"
new = "  'settings.subtitle': ['本地 IndexedDB 始终可独立工作；账号与云端同步用于跨设备恢复和未来 AI 接入。Excel 继续只承担初始导入与恢复。', 'Local IndexedDB always works independently; account and cloud sync support cross-device recovery and future AI access. Excel remains an initialization and recovery path.'],\n"
if old not in s:
    raise SystemExit('settings subtitle anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

# ---------- deploy workflow: public build variables ----------
p = Path('.github/workflows/deploy-pages.yml')
s = p.read_text()
anchor = """  build:
    runs-on: ubuntu-latest
    steps:
"""
replacement = """  build:
    runs-on: ubuntu-latest
    env:
      VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}
      VITE_SUPABASE_PUBLISHABLE_KEY: ${{ vars.VITE_SUPABASE_PUBLISHABLE_KEY }}
    steps:
"""
if anchor not in s:
    raise SystemExit('deploy build anchor missing')
s = s.replace(anchor, replacement, 1)
p.write_text(s)

# ---------- env / gitignore ----------
Path('.env.example').write_text('VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co\nVITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_ME\n')
p = Path('.gitignore')
s = p.read_text()
if '.env\n' not in s:
    s += '\n.env\n.env.*\n!.env.example\n'
p.write_text(s)

# ---------- Supabase schema ----------
supabase_dir = Path('supabase')
supabase_dir.mkdir(exist_ok=True)
(supabase_dir / 'schema.sql').write_text(r'''-- PJSDAS v1.0: one private cloud workspace per authenticated user.
-- Run this in the Supabase SQL editor. The browser must only receive the
-- Publishable/anon key; never expose a service_role key to GitHub Pages.

create table if not exists public.pjsdas_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  schema_version integer not null default 1 check (schema_version > 0),
  fingerprint text not null,
  snapshot jsonb not null,
  updated_by_device text not null,
  updated_at timestamptz not null default now()
);

alter table public.pjsdas_workspaces enable row level security;

revoke all on table public.pjsdas_workspaces from anon, authenticated;
grant select, insert, update, delete on table public.pjsdas_workspaces to authenticated;

drop policy if exists "pjsdas_workspace_select_own" on public.pjsdas_workspaces;
create policy "pjsdas_workspace_select_own"
on public.pjsdas_workspaces for select
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "pjsdas_workspace_insert_own" on public.pjsdas_workspaces;
create policy "pjsdas_workspace_insert_own"
on public.pjsdas_workspaces for insert
to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "pjsdas_workspace_update_own" on public.pjsdas_workspaces;
create policy "pjsdas_workspace_update_own"
on public.pjsdas_workspaces for update
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "pjsdas_workspace_delete_own" on public.pjsdas_workspaces;
create policy "pjsdas_workspace_delete_own"
on public.pjsdas_workspaces for delete
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
''')

# ---------- setup guide ----------
docs = Path('docs')
docs.mkdir(exist_ok=True)
(docs / 'CLOUD_SETUP.md').write_text(r'''# PJSDAS v1.0 Cloud Setup

PJSDAS remains fully usable without cloud configuration. Cloud mode adds Google sign-in and an account-isolated workspace snapshot for cross-device sync.

## 1. Create a Supabase project

Create a project in Supabase, then open the SQL editor and run `supabase/schema.sql` from this repository.

The schema creates one `pjsdas_workspaces` row per authenticated user and enables Row Level Security. Each user can select/insert/update/delete only the row whose `user_id` equals `auth.uid()`.

## 2. Configure Google OAuth in Supabase

Enable the Google provider in Supabase Auth. Create a Web OAuth client in Google Cloud / Google Auth Platform and copy the Client ID and Client Secret into the Supabase Google provider configuration.

Use the callback URL shown by Supabase for the Google OAuth client's authorized redirect URI.

For the PJSDAS web application, set the Supabase Site URL / redirect allow-list to include:

`https://haohongfei2001-png.github.io/pjsdas/`

For local development also add the local Vite URL you actually use.

## 3. Configure the GitHub Pages build

In the GitHub repository, add Actions **Variables** (not a service-role secret):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

The Pages workflow already exposes these two variables to the Vite build. Re-run the Pages deployment after adding them.

For local development, copy `.env.example` to `.env.local` and fill the same two values.

## 4. Security boundary

Never place a Supabase `service_role` key in the browser, repository, GitHub Pages variables, or any Vite-prefixed environment variable. PJSDAS relies on Supabase Auth plus database Row Level Security; the browser needs only the project URL and Publishable key.

## 5. Sync semantics

- IndexedDB remains the immediate source used by the UI.
- Cloud sync compares a SHA-256 fingerprint of normalized snapshot data.
- The cloud row has a monotonically increasing `revision`.
- If only local changed, PJSDAS uploads a new revision.
- If only cloud changed, PJSDAS replaces the local workspace with the validated cloud snapshot.
- If both changed after the last common revision, sync stops and asks the user which side to keep.
- A local browser workspace is bound to the first cloud account it syncs with. Signing into another account does not silently upload the existing local data.

The v1.0 cloud transport is deliberately snapshot-based. This keeps the current local-first domain model authoritative while creating a stable remote boundary for future MCP/API work.
''')

# ---------- pure tests ----------
Path('tests/cloudSyncLogic.test.ts').write_text(r'''import { describe, expect, it } from 'vitest'
import { decideSyncAction } from '../src/cloud/syncLogic'

describe('local-first cloud sync decisions', () => {
  it('creates cloud workspace when no remote row exists', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'local', localEmpty: false, remote: null })).toBe('create_remote')
  })

  it('pulls an existing cloud workspace into a new empty device', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'empty', localEmpty: true, remote: { revision: 4, fingerprint: 'remote' } })).toBe('pull_remote')
  })

  it('fails closed on first sync when both local and remote already contain different data', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'local', localEmpty: false, remote: { revision: 4, fingerprint: 'remote' } })).toBe('conflict')
  })

  it('pushes when only local changed since the common revision', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedRevision: 4, lastSyncedFingerprint: 'base' },
      localFingerprint: 'local-new',
      localEmpty: false,
      remote: { revision: 4, fingerprint: 'base' },
    })).toBe('push_local')
  })

  it('pulls when only remote changed since the common revision', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedRevision: 4, lastSyncedFingerprint: 'base' },
      localFingerprint: 'base',
      localEmpty: false,
      remote: { revision: 5, fingerprint: 'remote-new' },
    })).toBe('pull_remote')
  })

  it('stops on concurrent local and remote changes', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedRevision: 4, lastSyncedFingerprint: 'base' },
      localFingerprint: 'local-new',
      localEmpty: false,
      remote: { revision: 5, fingerprint: 'remote-new' },
    })).toBe('conflict')
  })

  it('adopts an equal remote fingerprint without rewriting either side', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'same', localEmpty: false, remote: { revision: 8, fingerprint: 'same' } })).toBe('adopt_equal')
  })
})
''')

Path('tests/workspaceFingerprint.test.ts').write_text(r'''import { describe, expect, it } from 'vitest'
import { createSnapshot } from '../src/snapshot'
import { DEFAULT_DECISION_RULES } from '../src/decisionRules'
import { canonicalWorkspaceJson, fingerprintWorkspace, workspaceIsEffectivelyEmpty } from '../src/cloud/workspaceFingerprint'

function snapshot(exportedAt: string, company?: string) {
  return createSnapshot({
    opportunities: company ? [{
      id: 'role-1', company, role: 'Product', currentStageLabel: '待投', processStage: 'not_applied', roleType: 'core', early: false,
      opportunityValue: 80, fitScore: 60, importedAt: '2026-09-11T00:00:00.000Z',
    }] : [],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
    decisionRules: { ...DEFAULT_DECISION_RULES, weights: { ...DEFAULT_DECISION_RULES.weights } },
    timeline: [], changeSets: [],
  }, exportedAt)
}

describe('cloud workspace fingerprint', () => {
  it('ignores snapshot export time', async () => {
    const a = snapshot('2026-09-11T00:00:00.000Z', 'Example')
    const b = snapshot('2026-09-12T00:00:00.000Z', 'Example')
    expect(canonicalWorkspaceJson(a)).toBe(canonicalWorkspaceJson(b))
    expect(await fingerprintWorkspace(a)).toBe(await fingerprintWorkspace(b))
  })

  it('changes when workspace data changes', async () => {
    expect(await fingerprintWorkspace(snapshot('2026-09-11T00:00:00.000Z', 'A')))
      .not.toBe(await fingerprintWorkspace(snapshot('2026-09-11T00:00:00.000Z', 'B')))
  })

  it('recognizes an untouched empty local workspace', () => {
    expect(workspaceIsEffectivelyEmpty(snapshot('2026-09-11T00:00:00.000Z'))).toBe(true)
    expect(workspaceIsEffectivelyEmpty(snapshot('2026-09-11T00:00:00.000Z', 'A'))).toBe(false)
  })
})
''')

# ---------- README ----------
p = Path('README.md')
s = p.read_text()
if '## v1.0 account and cloud sync' not in s:
    s += r'''

## v1.0 account and cloud sync

v1.0 keeps the local-first execution model: IndexedDB is still the immediate workspace used by the UI, and the application remains fully functional when cloud configuration is absent or the network is unavailable.

When Supabase is configured, PJSDAS adds Google sign-in and one private cloud workspace per authenticated user. The browser synchronizes a validated PJSDAS snapshot with a monotonically increasing cloud revision. A SHA-256 fingerprint identifies whether the local workspace changed. Only-local changes push; only-remote changes pull; concurrent changes fail closed into an explicit conflict instead of using last-write-wins.

The cloud row is protected by Supabase Row Level Security (`auth.uid() = user_id`). GitHub Pages receives only the project URL and Supabase Publishable key. A `service_role` key must never be exposed to the frontend.

The first sync binds the browser's current local workspace to that account. Signing into another account pauses synchronization rather than silently uploading the existing user's job-search data. Conflict resolution always requires an explicit choice between the local and cloud versions.

See `docs/CLOUD_SETUP.md` and `supabase/schema.sql` for deployment setup. Until those external settings are completed, the public site intentionally remains local-only while all v1.0 client-side sync code stays dormant.
'''
p.write_text(s)
