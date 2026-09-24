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
  clearLocalWorkspaceBinding,
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
  hasUnsyncedLocalWorkspace,
  runCloudSync,
  type CloudSyncOutcome,
} from './cloudSync.js'
import { assertCloudSignOutAllowed, assertConnectedSignOutDataSafe } from './cloudOperationGuard.js'
import { connectedWorkspaceAuthorityEnabled } from './connectedWorkspaceRepository.js'
import { clearLocalWorkspaceCache } from '../db.js'
import { replayAccountPendingOperations } from './authoritativeCommandClient.js'
import { enforceConnectedAccountCacheBoundary } from './accountCacheBoundary.js'

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
  syncNow: (options?: { passive?: boolean }) => Promise<CloudSyncOutcome | undefined>
  keepLocal: () => Promise<CloudSyncOutcome | undefined>
  useCloud: () => Promise<CloudSyncOutcome | undefined>
  rebindLocal: () => Promise<CloudSyncOutcome | undefined>
  setAutoSync: (enabled: boolean) => void
}

const CloudContext = createContext<CloudContextValue | null>(null)

export function CloudProvider({ children }: { children: ReactNode }) {
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

  const adoptSession = useCallback(async (next: CloudSession | null) => {
    if (connectedWorkspaceAuthorityEnabled()) {
      const owner = getCloudDeviceState().workspaceOwnerUserId
      const nextUserId = next?.user.id
      await enforceConnectedAccountCacheBoundary(
        owner,
        nextUserId,
        clearLocalWorkspaceCache,
        clearLocalWorkspaceBinding,
      )
    }
    applySession(next)
    if (next && connectedWorkspaceAuthorityEnabled()) {
      await replayAccountPendingOperations(next.user.id).catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught))
      })
    }
  }, [applySession])

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
        await adoptSession(next)
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
      void adoptSession(next)
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
  }, [adoptSession, finishPendingLink])

  const clearExpiredSessionIfNeeded = useCallback(async () => {
    const current = await getCloudSession()
    if (!current) await adoptSession(null)
  }, [adoptSession])

  const syncNow = useCallback(async (options?: { passive?: boolean }) => {
    const userId = session?.user.id
    if (!configured || !userId || busyRef.current) return undefined
    busyRef.current = true
    setSyncing(true)
    // A previous successful sync must not remain visible while a new attempt is
    // running or after that new attempt fails.
    setOutcome(undefined)
    setError(undefined)
    try {
      if (connectedWorkspaceAuthorityEnabled()) {
        await replayAccountPendingOperations(userId)
      }
      const result = await runCloudSync(userId, options)
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

    const initial = window.setTimeout(() => { void syncNow({ passive: true }).catch(() => undefined) }, 700)
    const interval = window.setInterval(() => { void syncNow({ passive: true }).catch(() => undefined) }, 120_000)
    const focus = () => { void syncNow({ passive: true }).catch(() => undefined) }
    const online = () => { void syncNow({ passive: true }).catch(() => undefined) }
    window.addEventListener('focus', focus)
    window.addEventListener('online', online)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
      window.removeEventListener('focus', focus)
      window.removeEventListener('online', online)
    }
  }, [loading, configured, session?.user.id, device.autoSync, device.workspaceOwnerUserId, checkpoint.conflict, syncNow])

  const runResolution = useCallback(async (kind: 'keep' | 'cloud' | 'rebind') => {
    const userId = session?.user.id
    if (!userId || busyRef.current) return undefined
    busyRef.current = true
    setSyncing(true)
    setOutcome(undefined)
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
    setOutcome(undefined)
    setError(undefined)
    try {
      await signInWithGoogle()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setLoading(false)
      throw caught
    }
  }, [])

  const signOut = useCallback(async () => {
    assertCloudSignOutAllowed({
      busy: busyRef.current,
      linking: linkingRef.current,
      loading,
    })
    const connected = connectedWorkspaceAuthorityEnabled()
    if (connected && session) {
      assertConnectedSignOutDataSafe({
        outcomeKind: outcome?.kind,
        hasConflict: Boolean(checkpoint.conflict),
        accountMismatch: Boolean(device.workspaceOwnerUserId && device.workspaceOwnerUserId !== session.user.id),
      })
      if (await hasUnsyncedLocalWorkspace(session.user.id)) {
        assertConnectedSignOutDataSafe({
          outcomeKind: 'local_pending',
          hasConflict: false,
          accountMismatch: false,
        })
      }
      // A background sync may have started while the local fingerprint was being read.
      // Recheck the operation gate before owning the sign-out critical section.
      assertCloudSignOutAllowed({
        busy: busyRef.current,
        linking: linkingRef.current,
        loading,
      })
    }
    busyRef.current = true
    setSyncing(true)
    try {
      if (connected && session) {
        const result = await runCloudSync(session.user.id, { passive: true })
        assertConnectedSignOutDataSafe({
          outcomeKind: result.kind,
          hasConflict: false,
          accountMismatch: false,
        })
      }
      await signOutCloud()
      if (connected) {
        await clearLocalWorkspaceCache()
        clearLocalWorkspaceBinding()
      }
      applySession(null)
      setOutcome(undefined)
      setError(undefined)
      setLoading(false)
    } finally {
      busyRef.current = false
      setSyncing(false)
    }
  }, [loading, session, outcome?.kind, checkpoint.conflict, device.workspaceOwnerUserId, applySession])

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
    signOut,
    syncNow,
    keepLocal: () => runResolution('keep'),
    useCloud: () => runResolution('cloud'),
    rebindLocal: () => runResolution('rebind'),
    setAutoSync: (enabled) => {
      setCloudAutoSync(enabled)
      refreshState(session?.user.id)
    },
  }), [configured, session, loading, syncing, device, checkpoint, outcome, error, signIn, signOut, syncNow, runResolution, refreshState])

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>
}

export function useCloud() {
  const value = useContext(CloudContext)
  if (!value) throw new Error('useCloud must be used inside CloudProvider')
  return value
}
