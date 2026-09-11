import { WorkspaceSourceError } from './workspaceSource.js'

export interface GoogleOAuthClientConfig {
  clientId: string
  clientSecret: string
  fetchImpl?: typeof fetch
}

export async function refreshGoogleAccessToken(
  refreshToken: string,
  config: GoogleOAuthClientConfig,
) {
  if (!refreshToken) throw new WorkspaceSourceError('GOOGLE_CONNECTION_REQUIRED', 'Google Drive is not connected to PJSDAS.', false)
  const fetchImpl = config.fetchImpl ?? fetch

  let response: Response
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
  } catch {
    throw new WorkspaceSourceError('GOOGLE_DRIVE_UNAVAILABLE', 'Google authorization service is temporarily unavailable.', true)
  }

  let data: { access_token?: string; error?: string }
  try {
    data = await response.json() as { access_token?: string; error?: string }
  } catch {
    throw new WorkspaceSourceError('GOOGLE_AUTH_EXPIRED', 'Google authorization response was invalid.', false)
  }

  if (!response.ok || !data.access_token) {
    const expired = response.status === 400 || response.status === 401 || data.error === 'invalid_grant'
    throw new WorkspaceSourceError(
      expired ? 'GOOGLE_AUTH_EXPIRED' : 'GOOGLE_DRIVE_UNAVAILABLE',
      expired ? 'Google authorization is no longer valid. Reconnect Google Drive to PJSDAS.' : 'Google authorization service could not refresh access.',
      !expired,
    )
  }

  return data.access_token
}
