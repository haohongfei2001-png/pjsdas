import type { Session, User } from '@supabase/supabase-js'

export interface CloudUser {
  /** Stable Google subject retained for backward-compatible local workspace ownership. */
  id: string
  /** Supabase account UUID used by the authenticated backend. */
  accountId: string
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

const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const ACCOUNT_LINK_PENDING_KEY = 'pjsdas-account-google-link-pending'
const LINK_ENDPOINT = 'https://pjsdas-remote-alpha-haohongfei2001-8529.vercel.app/api/google-link'
const ACCESS_TOKEN_ENDPOINT = 'https://pjsdas-remote-alpha-haohongfei2001-8529.vercel.app/api/google-access-token'

let googleAccessToken: string | undefined
let googleAccessTokenExpiresAt = 0

async function loadSupabase() {
  return (await import('../aiAccess/supabaseClient.js')).pjsdasSupabase
}

function googleSubject(user: User) {
  const metadata = user.user_metadata as Record<string, unknown> | undefined
  const direct = typeof metadata?.sub === 'string' ? metadata.sub.trim() : ''
  if (direct) return direct

  const googleIdentity = user.identities?.find((identity) => identity.provider === 'google')
  const identityData = googleIdentity?.identity_data as Record<string, unknown> | undefined
  const identitySub = typeof identityData?.sub === 'string' ? identityData.sub.trim() : ''
  if (identitySub) return identitySub

  // New accounts should always have a Google subject. Falling back to the
  // Supabase UUID keeps the account usable while remaining fail-closed for any
  // old local workspace that was bound to a different identifier.
  return user.id
}

function toCloudSession(session: Session): CloudSession {
  const metadata = session.user.user_metadata as Record<string, unknown> | undefined
  const fullName = typeof metadata?.full_name === 'string'
    ? metadata.full_name
    : typeof metadata?.name === 'string'
      ? metadata.name
      : undefined
  const avatarUrl = typeof metadata?.avatar_url === 'string'
    ? metadata.avatar_url
    : typeof metadata?.picture === 'string'
      ? metadata.picture
      : undefined

  return {
    user: {
      id: googleSubject(session.user),
      accountId: session.user.id,
      email: session.user.email,
      user_metadata: { full_name: fullName, avatar_url: avatarUrl },
    },
    expiresAt: (session.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000,
  }
}

function redirectUrl() {
  if (typeof window === 'undefined') return undefined
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('pjsdas_account_login', '1')
  return url.toString()
}

function hasPendingGoogleLink() {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(ACCOUNT_LINK_PENDING_KEY) === '1'
    || new URL(window.location.href).searchParams.get('pjsdas_account_login') === '1'
}

function clearCallbackUrl() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  let changed = false
  for (const key of ['code', 'sb_flow_id', 'pjsdas_account_login']) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key)
      changed = true
    }
  }
  if (changed) window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

async function persistGoogleDriveBinding(session: Session) {
  if (!session.provider_token || !session.provider_refresh_token) {
    throw new Error('Google 没有返回持续授权。请重新登录并在 Google 授权页确认允许 Drive appData 访问。')
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
  if (!response.ok) throw new Error(data.message || `Google Drive connection failed (HTTP ${response.status}).`)
  return data.googleEmail
}

export function invalidateCloudSession() {
  googleAccessToken = undefined
  googleAccessTokenExpiresAt = 0
}

export async function getCloudSession(): Promise<CloudSession | null> {
  const supabase = await loadSupabase()
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  return data.session ? toCloudSession(data.session) : null
}

export async function subscribeCloudSession(listener: (session: CloudSession | null) => void) {
  const supabase = await loadSupabase()
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    listener(session ? toCloudSession(session) : null)
  })
  return () => data.subscription.unsubscribe()
}

export async function completePendingGoogleLink() {
  if (!hasPendingGoogleLink()) return undefined
  const supabase = await loadSupabase()
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  if (!data.session) return undefined

  const email = await persistGoogleDriveBinding(data.session)
  window.localStorage.removeItem(ACCOUNT_LINK_PENDING_KEY)
  clearCallbackUrl()
  invalidateCloudSession()
  return email
}

export async function signInWithGoogle() {
  if (typeof window === 'undefined') return
  const supabase = await loadSupabase()
  window.localStorage.setItem(ACCOUNT_LINK_PENDING_KEY, '1')
  try {
    const { error } = await supabase.auth.signInWithOAuth({
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
    if (error) throw error
  } catch (caught) {
    window.localStorage.removeItem(ACCOUNT_LINK_PENDING_KEY)
    throw caught
  }
}

export async function signOutCloud() {
  invalidateCloudSession()
  if (typeof window !== 'undefined') window.localStorage.removeItem(ACCOUNT_LINK_PENDING_KEY)
  const supabase = await loadSupabase()
  const { error } = await supabase.auth.signOut({ scope: 'local' })
  if (error) throw error
}

async function accountAccessToken() {
  const supabase = await loadSupabase()
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  if (!data.session) throw new Error('PJSDAS 账号未登录。请先使用 Google 登录 PJSDAS。')
  return data.session.access_token
}

export async function getCloudAccessToken() {
  if (googleAccessToken && Date.now() < googleAccessTokenExpiresAt - 60_000) return googleAccessToken

  const response = await fetch(ACCESS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await accountAccessToken()}`,
      'content-type': 'application/json',
    },
  })
  const data = await response.json().catch(() => ({})) as {
    accessToken?: string
    expiresInSeconds?: number
    message?: string
    code?: string
  }
  if (!response.ok || !data.accessToken) {
    if (response.status === 401) invalidateCloudSession()
    throw new Error(data.message || `无法恢复 Google Drive 授权（HTTP ${response.status}）。`)
  }

  const expiresInSeconds = Number.isFinite(data.expiresInSeconds) ? Math.max(60, Number(data.expiresInSeconds)) : 3000
  googleAccessToken = data.accessToken
  googleAccessTokenExpiresAt = Date.now() + expiresInSeconds * 1000
  return googleAccessToken
}
