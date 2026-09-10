export interface CloudConfig {
  clientId: string
}

export const GOOGLE_DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
export const GOOGLE_OAUTH_SCOPES = ['openid', 'email', 'profile', GOOGLE_DRIVE_APPDATA_SCOPE].join(' ')

export function readCloudConfig(): CloudConfig | null {
  const env = import.meta.env as Record<string, string | undefined>
  const clientId = (env.VITE_GOOGLE_CLIENT_ID ?? '').trim()
  if (!clientId) return null
  return { clientId }
}
