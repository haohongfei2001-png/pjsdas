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
  completePendingGoogleLink,
  getCloudSession,
  signInWithGoogle,
  signOutCloud,
  subscribeCloudSession,
  type CloudSession,
} from './cloudClient.js'
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
  // The stable account uses the built-in Supabase project and the existing
  // authenticated Vercel gateway. No browser Google client ID is required.
  const configured = true
  const [session, setSession] = useState<CloudSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [device, setDevice] = useState(() => getCloudDeviceState())
  const [checkpoint, setCheckpoint] = useState<AccountSyncCheckpoint>({})
  const [outcome, setOutcome] = useState<CloudSyncOutcome>()
  const [error, setError] = useState<string>()
  const busyRef = useRef(false)
  const linkingRef = useRef(false)

  const refreshState = useCallback((userId?: string) => {
    setDevice(getCloudDeviceState())
    setCheckpoint(userId ? getAccountCheckpoint(userId) : {})
  }, [])

  const applySession = useCallback((next: CloudSession | null) => {
    setSession(next)
    refreshState(next?.user.id)
  }, [refreshState])

  const finishPendingLink = useCallback(async () => {
    if (linkingRef.current) return
    linkingRef.current = true
    try {
      await completePendingGoogleLink()
      setError(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      linkingRef.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined

    void getCloudSession()
      .then(async (next) => {
        if (!active) return
        applySession(next)
        if (next) await finishPendingLink()
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    void subscribeCloudSession((next) => {
      if (!active) return
      applySession(next)
      if (next) void finishPendingLink()
    }).then((cleanup) => {
      if (!active) cleanup()
      else unsubscribe = cleanup
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught))
    })

    return () => {
      active = false
      unsubscribe?.()
    }
  }, [applySession, finishPendingLink])

  const clearExpiredSessionIfNeeded = useCallback(async () => {
    const current = await getCloudSession()
    if (!current) applySession(null)
  }, [applySession])

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
    if (loading || !configured || !userId || !device.autoSync || checkpoint.conflict) return
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
  }, [loading, configured, session?.user.id, device.autoSync, device.workspaceOwnerUserId, checkpoint.conflict, syncNow])

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
    if (busyRef.current) return
    setLoading(true)
    setError(undefined)
    try {
      await signInWithGoogle()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setLoading(false)
      throw caught
    }
  }, [])

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
      applySession(null)
      setOutcome(undefined)
      setError(undefined)
      setLoading(false)
    },
    syncNow,
    keepLocal: () => runResolution('keep'),
    useCloud: () => runResolution('cloud'),
    rebindLocal: () => runResolution('rebind'),
    setAutoSync: (enabled) => {
      setCloudAutoSync(enabled)
      refreshState(session?.user.id)
    },
  }), [configured, session, loading, syncing, device, checkpoint, outcome, error, signIn, syncNow, runResolution, refreshState, applySession])

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>
}

export function useCloud() {
  const value = useContext(CloudContext)
  if (!value) throw new Error('useCloud must be used inside CloudProvider')
  return value
}
