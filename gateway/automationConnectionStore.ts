import type { GmailExecutionMetrics } from './gmailExecutionMetrics.js'
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
  gmailIntakeConsentVersion?: 'uu06-v1'
  gmailHistoryId?: string
  gmailLastCheckedAt?: string
  gmailSyncMode?: 'history' | 'fallback'
  gmailPageToken?: string
  gmailPendingHistoryId?: string
  gmailPendingMessageIds: string[]
  gmailWatchHistoryId?: string
  gmailWatchExpiresAt?: string
  gmailWatchLastRenewedAt?: string
  gmailWatchLastError?: string
}

type GmailBindingRow = {
  user_id?: string; google_subject?: string; google_email?: string | null;
  refresh_token_ciphertext?: string; granted_scopes?: string[] | null;
  gmail_history_id?: string | null; gmail_last_checked_at?: string | null;
  gmail_sync_mode?: 'history' | 'fallback' | null; gmail_page_token?: string | null;
  gmail_pending_history_id?: string | null; gmail_pending_message_ids?: string[] | null;
  gmail_intake_consent_version?: string | null;
  gmail_watch_history_id?: string | null; gmail_watch_expires_at?: string | null;
  gmail_watch_last_renewed_at?: string | null; gmail_watch_last_error?: string | null;
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

function gmailBinding(row: GmailBindingRow): GmailAutomationBinding[] {
  if (!row.user_id || !row.google_subject || !row.refresh_token_ciphertext) return []
  return [{
    userId: row.user_id,
    gmailIntakeConsentVersion: row.gmail_intake_consent_version === 'uu06-v1' ? 'uu06-v1' as const : undefined,
    googleSubject: row.google_subject,
    googleEmail: row.google_email ?? undefined,
    refreshTokenCiphertext: row.refresh_token_ciphertext,
    grantedScopes: row.granted_scopes ?? [],
    gmailHistoryId: row.gmail_history_id ?? undefined,
    gmailLastCheckedAt: row.gmail_last_checked_at ?? undefined,
    gmailSyncMode: row.gmail_sync_mode ?? undefined,
    gmailPageToken: row.gmail_page_token ?? undefined,
    gmailPendingHistoryId: row.gmail_pending_history_id ?? undefined,
    gmailPendingMessageIds: row.gmail_pending_message_ids ?? [],
    gmailWatchHistoryId: row.gmail_watch_history_id ?? undefined,
    gmailWatchExpiresAt: row.gmail_watch_expires_at ?? undefined,
    gmailWatchLastRenewedAt: row.gmail_watch_last_renewed_at ?? undefined,
    gmailWatchLastError: row.gmail_watch_last_error ?? undefined,
  }]
}

export function createAutomationConnectionStore(options: AutomationConnectionStoreOptions) {
  const baseUrl = options.supabaseUrl.replace(/\/+$/, '')
  const publishableKey = required(options.supabasePublishableKey, 'TodayAction Supabase publishable key')
  const workerToken = required(options.workerToken, 'TodayAction automation worker token')
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
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'TodayAction automation authorization store is temporarily unavailable.', true)
    }
    if (response.status === 401 || response.status === 403) {
      throw new WorkspaceSourceError('AUTOMATION_AUTH_REQUIRED', 'TodayAction automation worker authorization is invalid.', false)
    }
    if (response.status === 404) {
      const failure = await response.clone().json().catch(() => ({})) as { code?: string }
      if (failure.code === 'PGRST202' || failure.code === '42883') {
        throw new WorkspaceSourceError('AUTOMATION_RPC_NOT_DEPLOYED', 'The requested automation contract is not deployed.', false)
      }
    }
    if (!response.ok) {
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `TodayAction automation authorization store failed (HTTP ${response.status}).`, true)
    }
    const data = await response.json().catch(() => undefined) as T | undefined
    if (data === undefined) throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction automation authorization store returned invalid data.', false)
    return data
  }

  return {
    async listEnabledGmailBindings(): Promise<GmailAutomationBinding[]> {
      let rows: GmailBindingRow[]
      try {
        rows = await rpc<GmailBindingRow[]>('pjsdas_claim_gmail_automation_bindings_v4', { worker_token: workerToken })
      } catch (error) {
        if (!(error instanceof WorkspaceSourceError) || error.code !== 'AUTOMATION_RPC_NOT_DEPLOYED') throw error
        try {
          rows = await rpc<GmailBindingRow[]>('pjsdas_claim_gmail_automation_bindings_v3', { worker_token: workerToken })
        } catch (legacyError) {
          if (!(legacyError instanceof WorkspaceSourceError) || legacyError.code !== 'AUTOMATION_RPC_NOT_DEPLOYED') throw legacyError
          rows = await rpc<GmailBindingRow[]>('pjsdas_claim_gmail_automation_bindings_v2', { worker_token: workerToken })
          // Older database contract cannot prove expanded consent.
          rows = rows.map((row) => ({ ...row, gmail_intake_consent_version: null }))
        }
      }

      return rows.flatMap(gmailBinding)
    },

    async updateGmailRunState(userId: string, patch: {
      historyId?: string | null
      continuation?: {
        mode: 'history' | 'fallback'
        pageToken?: string
        pendingHistoryId: string
        pendingMessageIds: string[]
      } | null
      checkedAt?: string
      successAt?: string
      lastError?: string | null
    }) {
      await rpc<null>('pjsdas_update_gmail_automation_state_v2', {
        worker_token: workerToken,
        target_user_id: userId,
        next_history_id: 'historyId' in patch ? patch.historyId ?? null : null,
        next_sync_mode: patch.continuation?.mode ?? null,
        next_page_token: patch.continuation?.pageToken ?? null,
        next_pending_history_id: patch.continuation?.pendingHistoryId ?? null,
        next_pending_message_ids: patch.continuation?.pendingMessageIds ?? null,
        checked_at: patch.checkedAt ?? null,
        success_at: patch.successAt ?? null,
        last_error: 'lastError' in patch ? patch.lastError ?? null : null,
        set_history_id: 'historyId' in patch,
        set_continuation: Boolean(patch.continuation),
        clear_continuation: patch.continuation === null,
        set_last_error: 'lastError' in patch,
      })
    },

    async updateGmailWatchState(userId: string, patch: {
      historyId?: string | null
      expiresAt?: string | null
      renewedAt?: string | null
      lastError?: string | null
    }) {
      await rpc<null>('pjsdas_update_gmail_watch_state', {
        worker_token: workerToken,
        target_user_id: userId,
        watch_history_id: patch.historyId ?? null,
        watch_expires_at: patch.expiresAt ?? null,
        renewed_at: patch.renewedAt ?? null,
        last_error: patch.lastError ?? null,
        set_watch: Boolean(patch.historyId && patch.expiresAt && patch.renewedAt),
        clear_watch: patch.historyId === null || patch.expiresAt === null,
        set_last_error: 'lastError' in patch,
      })
    },

    async beginGmailExecution(userId: string, executionToken: string): Promise<GmailAutomationBinding | undefined> {
      const row = await rpc<GmailBindingRow | null>('pjsdas_begin_gmail_execution', {
        worker_token: workerToken, target_user_id: userId, execution_token: executionToken, ttl_seconds: 60,
      })
      return row ? gmailBinding(row)[0] : undefined
    },
    async assertGmailExecution(userId: string, executionToken: string) {
      const valid = await rpc<boolean>('pjsdas_assert_gmail_execution', {
        worker_token: workerToken, target_user_id: userId, execution_token: executionToken,
      })
      if (!valid) throw new WorkspaceSourceError('LEASE_LOST', 'Gmail execution lease is no longer valid.', true)
    },
    async finishGmailExecution(userId: string, executionToken: string, patch: Record<string, unknown>, metrics: GmailExecutionMetrics) {
      const finished = await rpc<boolean>('pjsdas_finish_gmail_execution', {
        worker_token: workerToken, target_user_id: userId, execution_token: executionToken, state_patch: patch, metrics,
      })
      if (!finished) throw new WorkspaceSourceError('LEASE_LOST', 'Gmail execution lease is no longer valid.', true)
    },

    async listDiscoveryBindings(): Promise<DiscoveryAutomationBinding[]> {
      const rows = await rpc<Array<{
        user_id?: string
        google_subject?: string
        google_email?: string | null
        refresh_token_ciphertext?: string
        granted_scopes?: string[] | null
        discovery_last_checked_at?: string | null
      }>>('pjsdas_claim_enabled_discovery_automation_bindings', { worker_token: workerToken })

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
