import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { pjsdasSupabase } from './supabaseClient'

const PENDING_KEY = 'pjsdas-ai-google-link-pending'
const LINK_ENDPOINT = 'https://pjsdas-remote-alpha-haohongfei2001-8529.vercel.app/api/google-link'
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'

type AiAccessState = {
  busy: boolean
  message: string
  error: string
  beginGoogleDriveLink: () => Promise<void>
}

const AiAccessContext = createContext<AiAccessState | null>(null)

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

async function persistGoogleLink(session: Session) {
  if (!session.provider_token || !session.provider_refresh_token) {
    throw new Error('Google 没有返回持续授权。请重新连接并在 Google 授权页确认允许访问。')
  }

  const response = await fetch(LINK_ENDPOINT, {
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
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const completing = useRef(false)

  async function completeIfPending(session: Session | null) {
    if (!session || typeof window === 'undefined') return
    const pending = window.sessionStorage.getItem(PENDING_KEY) === '1' || new URL(window.location.href).searchParams.get('pjsdas_ai_link') === '1'
    if (!pending || completing.current) return

    completing.current = true
    setBusy(true)
    setError('')
    try {
      const email = await persistGoogleLink(session)
      window.sessionStorage.removeItem(PENDING_KEY)
      clearCallbackUrl()
      setMessage(email ? `AI 读取授权已连接：${email}` : 'AI 读取授权已连接。')
      // The provider refresh token has already been encrypted server-side. Keep no
      // long-lived Supabase/Google linking session in the PJSDAS browser tab.
      await pjsdasSupabase.auth.signOut({ scope: 'local' })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
      completing.current = false
    }
  }

  useEffect(() => {
    let active = true
    void pjsdasSupabase.auth.getSession().then(({ data }) => {
      if (active) void completeIfPending(data.session)
    })
    const { data } = pjsdasSupabase.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => {
        if (active) void completeIfPending(session)
      }, 0)
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  async function beginGoogleDriveLink() {
    if (typeof window === 'undefined') return
    setBusy(true)
    setMessage('')
    setError('')
    window.sessionStorage.setItem(PENDING_KEY, '1')
    try {
      const { error: signInError } = await pjsdasSupabase.auth.signInWithOAuth({
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
      window.sessionStorage.removeItem(PENDING_KEY)
      setError(caught instanceof Error ? caught.message : String(caught))
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
