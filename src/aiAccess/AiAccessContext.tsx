import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { fetchBackend } from '../backendEndpoints.js'
import { useUiLanguage, type UiLanguage } from '../uiLanguage.js'

const PENDING_KEY = 'pjsdas-ai-google-link-pending'
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const OFFLINE_AUTH_MISSING = 'AI_ACCESS_GOOGLE_OFFLINE_AUTH_MISSING'

type AiAccessState = {
  busy: boolean
  message: string
  error: string
  beginGoogleDriveLink: () => Promise<void>
}

const AiAccessContext = createContext<AiAccessState | null>(null)

export function aiAccessConnectedMessage(email: string | undefined, lang: UiLanguage) {
  if (lang === 'zh') return email ? `AI 读取授权已连接：${email}` : 'AI 读取授权已连接。'
  return email ? `AI read access connected: ${email}` : 'AI read access connected.'
}

export function aiAccessErrorMessage(caught: unknown, lang: UiLanguage) {
  const raw = caught instanceof Error ? caught.message : String(caught)
  if (raw === OFFLINE_AUTH_MISSING) {
    return lang === 'zh'
      ? 'Google 没有返回持续授权。请重新连接，并在 Google 授权页确认允许访问。'
      : 'Google did not return durable authorization. Reconnect and confirm access on the Google consent screen.'
  }
  return raw
}

async function loadSupabase() {
  return (await import('./supabaseClient.js')).pjsdasSupabase
}

function redirectUrl() {
  if (typeof window === 'undefined') return undefined
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('pjsdas_ai_link', '1')
  return url.toString()
}

function clearCallbackUrl() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  let changed = false
  for (const key of ['code', 'sb_flow_id', 'pjsdas_ai_link']) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key)
      changed = true
    }
  }
  if (changed) window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

function clearPendingGoogleLinkState() {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(PENDING_KEY)
  clearCallbackUrl()
}

function hasPendingGoogleLink() {
  if (typeof window === 'undefined') return false
  return window.sessionStorage.getItem(PENDING_KEY) === '1'
    || new URL(window.location.href).searchParams.get('pjsdas_ai_link') === '1'
}

async function persistGoogleLink(session: Session) {
  if (!session.provider_token || !session.provider_refresh_token) {
    throw new Error(OFFLINE_AUTH_MISSING)
  }

  const response = await fetchBackend('/api/google-link', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      providerToken: session.provider_token,
      providerRefreshToken: session.provider_refresh_token,
    }),
  })

  const data = await response.json().catch(() => ({})) as { message?: string; googleEmail?: string }
  if (!response.ok) throw new Error(data.message || `AI access setup failed (HTTP ${response.status}).`)
  return data.googleEmail
}

export function AiAccessProvider({ children }: { children: ReactNode }) {
  const { lang } = useUiLanguage()
  const [busy, setBusy] = useState(false)
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null)
  const [error, setError] = useState('')
  const completing = useRef(false)
  const message = connectedEmail === null ? '' : aiAccessConnectedMessage(connectedEmail || undefined, lang)

  async function completeIfPending(session: Session | null) {
    if (!session || !hasPendingGoogleLink() || completing.current) return

    completing.current = true
    setBusy(true)
    setError('')
    try {
      const email = await persistGoogleLink(session)
      clearPendingGoogleLinkState()
      setConnectedEmail(email ?? '')
      // The same durable Supabase session is now the PJSDAS account session.
      // Do not sign it out after saving the encrypted Google refresh token.
    } catch (caught) {
      clearPendingGoogleLinkState()
      setError(aiAccessErrorMessage(caught, lang))
    } finally {
      setBusy(false)
      completing.current = false
    }
  }

  useEffect(() => {
    if (!hasPendingGoogleLink()) return

    let active = true
    let unsubscribe: (() => void) | undefined

    void loadSupabase().then(async (supabase) => {
      if (!active) return
      const { data } = await supabase.auth.getSession()
      if (active) void completeIfPending(data.session)
      const listener = supabase.auth.onAuthStateChange((_event, session) => {
        window.setTimeout(() => {
          if (active) void completeIfPending(session)
        }, 0)
      })
      unsubscribe = () => listener.data.subscription.unsubscribe()
    }).catch((caught) => {
      if (active) {
        clearPendingGoogleLinkState()
        setError(aiAccessErrorMessage(caught, lang))
      }
    })

    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  async function beginGoogleDriveLink() {
    if (typeof window === 'undefined') return
    setBusy(true)
    setConnectedEmail(null)
    setError('')
    window.sessionStorage.setItem(PENDING_KEY, '1')
    try {
      const supabase = await loadSupabase()
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: redirectUrl(),
          scopes: `openid email profile ${DRIVE_APPDATA_SCOPE}`,
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
            include_granted_scopes: 'true',
          },
        },
      })
      if (signInError) throw signInError
    } catch (caught) {
      clearPendingGoogleLinkState()
      setError(aiAccessErrorMessage(caught, lang))
      setBusy(false)
    }
  }

  return (
    <AiAccessContext.Provider value={{ busy, message, error, beginGoogleDriveLink }}>
      {children}
    </AiAccessContext.Provider>
  )
}

export function useAiAccess() {
  const value = useContext(AiAccessContext)
  if (!value) throw new Error('useAiAccess must be used inside AiAccessProvider.')
  return value
}
