import { googleAuthorizationErrorCode } from '../src/googleConnectionHealth.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface GoogleDriveBinding {
  googleSubject: string
  googleEmail?: string
  refreshTokenCiphertext: string
  grantedScopes: string[]
}

export interface GoogleConnectionStoreOptions {
  supabaseUrl: string
  publishableKey: string
  fetchImpl?: typeof fetch
}

export function createGoogleConnectionStore(options: GoogleConnectionStoreOptions) {
  const baseUrl = options.supabaseUrl.replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    async updateRefreshState(userId: string, userAccessToken: string, expectedCiphertext: string,
      patch: { nextCiphertext?: string; reconnectRequired?: boolean }) {
      const params = new URLSearchParams({ user_id: `eq.${userId}`,
        refresh_token_ciphertext: `eq.${expectedCiphertext}`, revoked_at: 'is.null', select: 'user_id,updated_at',
        and: '(or(gmail_last_error.is.null,gmail_last_error.not.like.GOOGLE_AUTH_EXPIRED*),or(discovery_last_error.is.null,discovery_last_error.not.like.GOOGLE_AUTH_EXPIRED*))' })
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}/rest/v1/google_drive_connections?${params}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${userAccessToken}`, apikey: options.publishableKey,
            'content-type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ updated_at: new Date().toISOString(),
            ...(patch.nextCiphertext ? { refresh_token_ciphertext: patch.nextCiphertext } : {}),
            ...(patch.reconnectRequired ? { gmail_last_error: 'GOOGLE_AUTH_EXPIRED: Reconnect Google to resume.',
              discovery_last_error: 'GOOGLE_AUTH_EXPIRED: Reconnect Google to resume.' } : {}),
          }),
        })
      } catch { throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Google connection state could not be saved.', true) }
      if (!response.ok) throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Google connection state could not be saved.', true)
      const rows = await response.json().catch(() => undefined)
      if (!Array.isArray(rows)) throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Google connection state was not confirmed.', true)
      if (rows.length !== 1 || rows[0]?.user_id !== userId) {
        throw new WorkspaceSourceError('GOOGLE_CONNECTION_CHANGED', 'Google connection changed during refresh. Retry with the current connection.', true)
      }
      if (typeof rows[0].updated_at !== 'string') throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Google connection version was not confirmed.', true)
      return { updatedAt: rows[0].updated_at }
    },
    async readForUser(userId: string, userAccessToken: string): Promise<GoogleDriveBinding> {
      const params = new URLSearchParams({
        select: 'user_id,google_subject,google_email,refresh_token_ciphertext,granted_scopes,revoked_at,gmail_last_error,discovery_last_error',
        user_id: `eq.${userId}`,
        revoked_at: 'is.null',
        limit: '1',
      })

      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}/rest/v1/google_drive_connections?${params.toString()}`, {
          headers: {
            Authorization: `Bearer ${userAccessToken}`,
            apikey: options.publishableKey,
          },
        })
      } catch {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'TodayAction authorization store is temporarily unavailable.', true)
      }

      if (response.status === 401 || response.status === 403) {
        throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction authorization is invalid or expired.', false)
      }
      if (!response.ok) {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `TodayAction authorization store failed (HTTP ${response.status}).`, true)
      }

      let rows: Array<{
        user_id?: string
        google_subject?: string
        google_email?: string | null
        refresh_token_ciphertext?: string
        granted_scopes?: string[] | null
        gmail_last_error?: string | null
        discovery_last_error?: string | null
      }>
      try {
        rows = await response.json()
      } catch {
        throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction authorization store returned invalid data.', false)
      }

      const row = rows[0]
      if (!row) throw new WorkspaceSourceError('GOOGLE_CONNECTION_REQUIRED', 'Connect Google Drive to TodayAction before using real workspace data.', false)
      if (row.user_id !== userId || !row.google_subject || !row.refresh_token_ciphertext) {
        throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction Google Drive binding is invalid.', false)
      }

      if ([row.gmail_last_error, row.discovery_last_error].some((error) => googleAuthorizationErrorCode(error) === 'GOOGLE_AUTH_EXPIRED')) {
        throw new WorkspaceSourceError('GOOGLE_AUTH_EXPIRED', 'Reconnect Google to resume this connection.', false)
      }

      return {
        googleSubject: row.google_subject,
        googleEmail: row.google_email ?? undefined,
        refreshTokenCiphertext: row.refresh_token_ciphertext,
        grantedScopes: row.granted_scopes ?? [],
      }
    },
  }
}
