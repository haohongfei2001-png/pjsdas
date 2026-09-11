import { GOOGLE_OAUTH_SCOPES, readCloudConfig } from './cloudConfig.js'

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
