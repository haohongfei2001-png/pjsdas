import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { fetchBackend } from '../backendEndpoints.js'
import { useUiLanguage, type UiLanguage } from '../uiLanguage.js'

const PENDING_KEY = 'pjsdas-ai-google-link-pending'
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const OFFLINE_AUTH_MISSING = 'AI_ACCESS_GOOGLE_OFFLINE_AUTH_MISSING'

type GoogleLinkMode = 'drive' | 'gmail'

export interface GmailAutomationStatus {
  googleEmail: string | null
  gmailScopeGranted: boolean
  gmailEnabled: boolean
  gmailHistoryIdPresent: boolean
  gmailLastCheckedAt: string | null
  gmailLastSuccessAt: string | null
  gmailLastError: string | null
}

type AiAccessState = {
  busy: boolean
  message: string
  error: string
  gmailAutomation: GmailAutomationStatus | null
  beginGoogleDriveLink: () => Promise<void>
  beginGmailAutomationLink: () => Promise<void>
  setGmailAutomationEnabled: (enabled: boolean) => Promise<void>
  refreshGmailAutomationStatus: () => Promise<void>
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

function redirectUrl(mode: GoogleLinkMode) {
  if (typeof window === 'undefined') return undefined
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('pjsdas_ai_link', mode)
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

function pendingGoogleLinkMode(): GoogleLinkMode | undefined {
  if (typeof window === 'undefined') return undefined
  const stored = window.sessionStorage.getItem(PENDING_KEY)
  if (stored === 'gmail') return 'gmail'
  if (stored === 'drive' || stored === '1') return 'drive'
  const param = new URL(window.location.href).searchParams.get('pjsdas_ai_link')
  if (param === 'gmail') return 'gmail'
  if (param === 'drive' || param === '1') return 'drive'
  return undefined
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

  const data = await response.json().catch(() => ({})) as { message?: string; googleEmail?: string; scopes?: string[] }
  if (!response.ok) throw new Error(data.message || `AI access setup failed (HTTP ${response.status}).`)
  return data
}

async function readAutomationStatus(session: Session) {
  const response = await fetchBackend('/api/automation-settings', {
    headers: { authorization: `Bearer ${session.access_token}` },
  })
  const data = await response.json().catch(() => ({})) as GmailAutomationStatus & { message?: string }
  if (!response.ok) throw new Error(data.message || `Automation settings failed (HTTP ${response.status}).`)
  return data
}

async function writeAutomationStatus(session: Session, enabled: boolean) {
  const response = await fetchBackend('/api/automation-settings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ gmailEnabled: enabled }),
  })
  const data = await response.json().catch(() => ({})) as GmailAutomationStatus & { message?: string }
  if (!response.ok) throw new Error(data.message || `Automation settings update failed (HTTP ${response.status}).`)
  return data
}

export function AiAccessProvider({ children }: { children: ReactNode }) {
  const { lang } = useUiLanguage()
  const [busy, setBusy] = useState(false)
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null)
  const [gmailAutomation, setGmailAutomation] = useState<GmailAutomationStatus | null>(null)
  const [error, setError] = useState('')
  const completing = useRef(false)
  const message = connectedEmail === null ? '' : aiAccessConnectedMessage(connectedEmail || undefined, lang)

  async function refreshStatusForSession(session: Session | null) {
    if (!session) {
      setGmailAutomation(null)
      return
    }
    try {
      setGmailAutomation(await readAutomationStatus(session))
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : String(caught)
      if (!/Connect Google|Google.*before enabling|HTTP 400/i.test(raw)) throw caught
      setGmailAutomation(null)
    }
  }

  async function completeIfPending(session: Session | null) {
    const mode = pendingGoogleLinkMode()
    if (!session || !mode || completing.current) return

    completing.current = true
    setBusy(true)
    setError('')
    try {
      const linked = await persistGoogleLink(session)
      if (mode === 'gmail') {
        setGmailAutomation(await writeAutomationStatus(session, true))
      } else {
        await refreshStatusForSession(session)
      }
      clearPendingGoogleLinkState()
      setConnectedEmail(linked.googleEmail ?? '')
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
    let active = true
    let unsubscribe: (() => void) | undefined

    void loadSupabase().then(async (supabase) => {
      if (!active) return
      const { data } = await supabase.auth.getSession()
      if (active) {
        if (pendingGoogleLinkMode()) void completeIfPending(data.session)
        else void refreshStatusForSession(data.session).catch((caught) => setError(aiAccessErrorMessage(caught, lang)))
      }
      const listener = supabase.auth.onAuthStateChange((_event, session) => {
        window.setTimeout(() => {
          if (!active) return
          if (pendingGoogleLinkMode()) void completeIfPending(session)
          else void refreshStatusForSession(session).catch((caught) => setError(aiAccessErrorMessage(caught, lang)))
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

  async function beginGoogleLink(mode: GoogleLinkMode) {
    if (typeof window === 'undefined') return
    setBusy(true)
    setConnectedEmail(null)
    setError('')
    window.sessionStorage.setItem(PENDING_KEY, mode)
    try {
      const supabase = await loadSupabase()
      const scopes = mode === 'gmail'
        ? `openid email profile ${DRIVE_APPDATA_SCOPE} ${GMAIL_READONLY_SCOPE}`
        : `openid email profile ${DRIVE_APPDATA_SCOPE}`
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: redirectUrl(mode),
          scopes,
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

  async function beginGoogleDriveLink() {
    return beginGoogleLink('drive')
  }

  async function beginGmailAutomationLink() {
    return beginGoogleLink('gmail')
  }

  async function setGmailAutomationEnabled(enabled: boolean) {
    if (enabled && !gmailAutomation?.gmailScopeGranted) {
      await beginGmailAutomationLink()
      return
    }
    setBusy(true)
    setError('')
    try {
      const supabase = await loadSupabase()
      const { data, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) throw sessionError
      if (!data.session) throw new Error(lang === 'zh' ? '请先使用 Google 登录 PJSDAS。' : 'Sign in to PJSDAS with Google first.')
      setGmailAutomation(await writeAutomationStatus(data.session, enabled))
    } catch (caught) {
      setError(aiAccessErrorMessage(caught, lang))
    } finally {
      setBusy(false)
    }
  }

  async function refreshGmailAutomationStatus() {
    setError('')
    try {
      const supabase = await loadSupabase()
      const { data, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) throw sessionError
      await refreshStatusForSession(data.session)
    } catch (caught) {
      setError(aiAccessErrorMessage(caught, lang))
    }
  }

  return (
    <AiAccessContext.Provider value={{
      busy,
      message,
      error,
      gmailAutomation,
      beginGoogleDriveLink,
      beginGmailAutomationLink,
      setGmailAutomationEnabled,
      refreshGmailAutomationStatus,
    }}>
      {children}
    </AiAccessContext.Provider>
  )
}

export function useAiAccess() {
  const value = useContext(AiAccessContext)
  if (!value) throw new Error('useAiAccess must be used inside AiAccessProvider.')
  return value
}
