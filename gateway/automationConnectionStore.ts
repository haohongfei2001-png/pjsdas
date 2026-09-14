import { WorkspaceSourceError } from './workspaceSource.js'

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

interface GoogleAutomationBinding {
  userId: string
  googleSubject: string
  googleEmail?: string
  refreshTokenCiphertext: string
  grantedScopes: string[]
}

export interface GmailAutomationBinding extends GoogleAutomationBinding {
  gmailHistoryId?: string
  gmailLastCheckedAt?: string
}

export interface DiscoveryAutomationBinding extends GoogleAutomationBinding {
  discoveryLastCheckedAt?: string
}

export interface AutomationConnectionStoreOptions {
  supabaseUrl: string
  supabasePublishableKey: string
  workerToken: string
  fetchImpl?: typeof fetch
}

function required(value: string, name: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new WorkspaceSourceError('AUTOMATION_AUTH_REQUIRED', `${name} is required.`, false)
  return trimmed
}

export function createAutomationConnectionStore(options: AutomationConnectionStoreOptions) {
  const baseUrl = options.supabaseUrl.replace(/\/+$/, '')
  const publishableKey = required(options.supabasePublishableKey, 'PJSDAS Supabase publishable key')
  const workerToken = required(options.workerToken, 'PJSDAS automation worker token')
  const fetchImpl = options.fetchImpl ?? fetch
  const headers = {
    apikey: publishableKey,
    'content-type': 'application/json',
  }

  async function rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    } catch {
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'PJSDAS automation authorization store is temporarily unavailable.', true)
    }
    if (response.status === 401 || response.status === 403) {
      throw new WorkspaceSourceError('AUTOMATION_AUTH_REQUIRED', 'PJSDAS automation worker authorization is invalid.', false)
    }
    if (!response.ok) {
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `PJSDAS automation authorization store failed (HTTP ${response.status}).`, true)
    }
    const data = await response.json().catch(() => undefined) as T | undefined
    if (data === undefined) throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS automation authorization store returned invalid data.', false)
    return data
  }

  return {
    async listEnabledGmailBindings(): Promise<GmailAutomationBinding[]> {
      const rows = await rpc<Array<{
        user_id?: string
        google_subject?: string
        google_email?: string | null
        refresh_token_ciphertext?: string
        granted_scopes?: string[] | null
        gmail_history_id?: string | null
        gmail_last_checked_at?: string | null
      }>>('pjsdas_claim_gmail_automation_bindings', { worker_token: workerToken })

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
      await rpc<null>('pjsdas_update_gmail_automation_state', {
        worker_token: workerToken,
        target_user_id: userId,
        next_history_id: 'historyId' in patch ? patch.historyId ?? null : null,
        checked_at: patch.checkedAt ?? null,
        success_at: patch.successAt ?? null,
        last_error: 'lastError' in patch ? patch.lastError ?? null : null,
        set_history_id: 'historyId' in patch,
        set_last_error: 'lastError' in patch,
      })
    },

    async listDiscoveryBindings(): Promise<DiscoveryAutomationBinding[]> {
      const rows = await rpc<Array<{
        user_id?: string
        google_subject?: string
        google_email?: string | null
        refresh_token_ciphertext?: string
        granted_scopes?: string[] | null
        discovery_last_checked_at?: string | null
      }>>('pjsdas_claim_discovery_automation_bindings', { worker_token: workerToken })

      return rows.flatMap((row) => {
        if (!row.user_id || !row.google_subject || !row.refresh_token_ciphertext) return []
        return [{
          userId: row.user_id,
          googleSubject: row.google_subject,
          googleEmail: row.google_email ?? undefined,
          refreshTokenCiphertext: row.refresh_token_ciphertext,
          grantedScopes: row.granted_scopes ?? [],
          discoveryLastCheckedAt: row.discovery_last_checked_at ?? undefined,
        }]
      })
    },

    async updateDiscoveryRunState(userId: string, patch: {
      checkedAt?: string
      successAt?: string
      lastError?: string | null
    }) {
      await rpc<null>('pjsdas_update_discovery_automation_state', {
        worker_token: workerToken,
        target_user_id: userId,
        checked_at: patch.checkedAt ?? null,
        success_at: patch.successAt ?? null,
        last_error: 'lastError' in patch ? patch.lastError ?? null : null,
        set_last_error: 'lastError' in patch,
      })
    },
  }
}
