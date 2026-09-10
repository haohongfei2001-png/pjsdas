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
