import { WorkspaceSourceError } from './workspaceSource'

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
    async readForUser(userId: string, userAccessToken: string): Promise<GoogleDriveBinding> {
      const params = new URLSearchParams({
        select: 'user_id,google_subject,google_email,refresh_token_ciphertext,granted_scopes,revoked_at',
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
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'PJSDAS authorization store is temporarily unavailable.', true)
      }

      if (response.status === 401 || response.status === 403) {
        throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS authorization is invalid or expired.', false)
      }
      if (!response.ok) {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `PJSDAS authorization store failed (HTTP ${response.status}).`, true)
      }

      let rows: Array<{
        user_id?: string
        google_subject?: string
        google_email?: string | null
        refresh_token_ciphertext?: string
        granted_scopes?: string[] | null
      }>
      try {
        rows = await response.json()
      } catch {
        throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS authorization store returned invalid data.', false)
      }

      const row = rows[0]
      if (!row) throw new WorkspaceSourceError('GOOGLE_CONNECTION_REQUIRED', 'Connect Google Drive to PJSDAS before using real workspace data.', false)
      if (row.user_id !== userId || !row.google_subject || !row.refresh_token_ciphertext) {
        throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS Google Drive binding is invalid.', false)
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
