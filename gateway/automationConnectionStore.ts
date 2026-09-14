import { WorkspaceSourceError } from './workspaceSource.js'

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export interface GmailAutomationBinding {
  userId: string
  googleSubject: string
  googleEmail?: string
  refreshTokenCiphertext: string
  grantedScopes: string[]
  gmailHistoryId?: string
  gmailLastCheckedAt?: string
}

export interface AutomationConnectionStoreOptions {
  supabaseUrl: string
  serviceRoleKey: string
  fetchImpl?: typeof fetch
}

function requiredSecret(value: string, name: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', `${name} is not configured.`, false)
  return trimmed
}

export function createAutomationConnectionStore(options: AutomationConnectionStoreOptions) {
  const baseUrl = options.supabaseUrl.replace(/\/+$/, '')
  const serviceRoleKey = requiredSecret(options.serviceRoleKey, 'PJSDAS Supabase service-role key')
  const fetchImpl = options.fetchImpl ?? fetch
  const headers = {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    'content-type': 'application/json',
  }

  return {
    async listEnabledGmailBindings(): Promise<GmailAutomationBinding[]> {
      const params = new URLSearchParams({
        select: 'user_id,google_subject,google_email,refresh_token_ciphertext,granted_scopes,gmail_history_id,gmail_last_checked_at',
        gmail_automation_enabled: 'eq.true',
        revoked_at: 'is.null',
        order: 'updated_at.asc',
      })
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}/rest/v1/google_drive_connections?${params.toString()}`, { headers })
      } catch {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'PJSDAS automation authorization store is temporarily unavailable.', true)
      }
      if (!response.ok) {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `PJSDAS automation authorization store failed (HTTP ${response.status}).`, true)
      }
      const rows = await response.json().catch(() => undefined) as Array<{
        user_id?: string
        google_subject?: string
        google_email?: string | null
        refresh_token_ciphertext?: string
        granted_scopes?: string[] | null
        gmail_history_id?: string | null
        gmail_last_checked_at?: string | null
      }> | undefined
      if (!rows) throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS automation authorization store returned invalid data.', false)
      return rows.flatMap((row) => {
        if (!row.user_id || !row.google_subject || !row.refresh_token_ciphertext) return []
        return [{
          userId: row.user_id,
          googleSubject: row.google_subject,
          googleEmail: row.google_email ?? undefined,
          refreshTokenCiphertext: row.refresh_token_ciphertext,
          grantedScopes: row.granted_scopes ?? [],
          gmailHistoryId: row.gmail_history_id ?? undefined,
          gmailLastCheckedAt: row.gmail_last_checked_at ?? undefined,
        }]
      })
    },

    async updateGmailRunState(userId: string, patch: {
      historyId?: string | null
      checkedAt?: string
      successAt?: string
      lastError?: string | null
    }) {
      const body: Record<string, string | null> = {}
      if ('historyId' in patch) body.gmail_history_id = patch.historyId ?? null
      if (patch.checkedAt) body.gmail_last_checked_at = patch.checkedAt
      if (patch.successAt) body.gmail_last_success_at = patch.successAt
      if ('lastError' in patch) body.gmail_last_error = patch.lastError ?? null
      body.updated_at = patch.checkedAt ?? new Date().toISOString()
      const params = new URLSearchParams({ user_id: `eq.${userId}` })
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}/rest/v1/google_drive_connections?${params.toString()}`, {
          method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(body),
        })
      } catch {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'PJSDAS automation state could not be saved.', true)
      }
      if (!response.ok) {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `PJSDAS automation state update failed (HTTP ${response.status}).`, true)
      }
    },
  }
}
