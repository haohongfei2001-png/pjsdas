import {
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
} from './cloudClient.js'
import { readCloudConfig } from './cloudConfig.js'
import {
  getAccountCheckpoint,
  getCloudDeviceState,
  setCloudAutoSync,
  type AccountSyncCheckpoint,
  type CloudDeviceState,
} from './syncState.js'
import {
  rebindCurrentLocalWorkspace,
  resolveConflictKeepLocal,
  resolveConflictUseCloud,
  runCloudSync,
  type CloudSyncOutcome,
} from './cloudSync.js'

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
