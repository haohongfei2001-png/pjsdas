import { createGoogleConnectionStore } from './googleConnectionStore.js'
import { googleRefreshLifecycle } from './googleRefreshLifecycle.js'
import type { DiscoveryReadiness } from '../src/discoveryReadiness.js'
import { GMAIL_READONLY_SCOPE } from './automationConnectionStore.js'
import { registerGmailWatch, type GmailWatchResult } from './gmailWatch.js'
import { createSupabaseIdentityResolver } from './supabaseIdentity.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface AutomationSettingsHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  allowedOrigins: string[]
  fetchImpl?: typeof fetch
  readDiscoveryReadiness?: (userId: string) => Promise<DiscoveryReadiness>
  tokenEncryptionKey?: string
  googleClientId?: string
  googleClientSecret?: string
  gmailPushTopicName?: string
  gmailDeliveryMode?: 'polling' | 'push'
  gmailExecutionControlsEnabled?: boolean
  registerGmailWatchImpl?: typeof registerGmailWatch
  now?: () => Date
  authorizeIdentity?: (identity: import('./supabaseIdentity.js').PjsdasIdentity) => Promise<unknown>
}

interface AutomationRow {
  user_id?: string
  updated_at?: string
  google_email?: string | null
  refresh_token_ciphertext?: string | null
  granted_scopes?: string[] | null
  gmail_automation_enabled?: boolean | null
  gmail_intake_consent_version?: string | null
  gmail_history_id?: string | null
  gmail_sync_mode?: string | null
  gmail_page_token?: string | null
  gmail_pending_history_id?: string | null
  gmail_pending_message_ids?: string[] | null
  gmail_last_checked_at?: string | null
  gmail_last_success_at?: string | null
  gmail_last_error?: string | null
  discovery_automation_enabled?: boolean | null
  discovery_last_checked_at?: string | null
  discovery_last_success_at?: string | null
  discovery_last_error?: string | null
}

function corsHeaders(origin: string | null, allowedOrigins: string[]) {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    vary: 'Origin',
  })
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('access-control-allow-origin', origin)
    headers.set('access-control-allow-headers', 'authorization, content-type')
    headers.set('access-control-allow-methods', 'GET, POST, OPTIONS')
  }
  return headers
}

function json(status: number, body: unknown, origin: string | null, allowedOrigins: string[]) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin, allowedOrigins) })
}

function statusForRow(row: AutomationRow) {
  const scopes = row.granted_scopes ?? []
  return {
    googleEmail: row.google_email ?? null,
    gmailScopeGranted: scopes.includes(GMAIL_READONLY_SCOPE),
    gmailEnabled: Boolean(row.gmail_automation_enabled),
    gmailHistoryIdPresent: Boolean(row.gmail_history_id),
    gmailLastCheckedAt: row.gmail_last_checked_at ?? null,
    gmailLastSuccessAt: row.gmail_last_success_at ?? null,
    gmailLastError: row.gmail_last_error ?? null,
    discoveryEnabled: Boolean(row.discovery_automation_enabled),
    discoveryLastCheckedAt: row.discovery_last_checked_at ?? null,
    // Backward-compatible legacy name. New consumers should read
    // discoveryLastCommitAt: this timestamp advances only after at least one
    // source run is durably committed.
    discoveryLastSuccessAt: row.discovery_last_success_at ?? null,
    discoveryLastCommitAt: row.discovery_last_success_at ?? null,
    discoveryLastError: row.discovery_last_error ?? null,
  }
}

export function createAutomationSettingsHandler(config: AutomationSettingsHandlerConfig) {
  const baseUrl = config.supabaseUrl.replace(/\/+$/, '')
  const fetchImpl = config.fetchImpl ?? fetch
  const resolveIdentity = createSupabaseIdentityResolver({
    supabaseUrl: config.supabaseUrl,
    publishableKey: config.supabasePublishableKey,
    fetchImpl,
  })

  async function readRow(userId: string, accessToken: string) {
    const params = new URLSearchParams({
      select: [
        'user_id',
        'updated_at',
        'google_email',
        'refresh_token_ciphertext',
        'granted_scopes',
        'gmail_automation_enabled',
        'gmail_intake_consent_version',
        'gmail_history_id',
        'gmail_sync_mode',
        'gmail_page_token',
        'gmail_pending_history_id',
        'gmail_pending_message_ids',
        'gmail_last_checked_at',
        'gmail_last_success_at',
        'gmail_last_error',
        'discovery_automation_enabled',
        'discovery_last_checked_at',
        'discovery_last_success_at',
        'discovery_last_error',
      ].join(','),
      user_id: `eq.${userId}`,
      revoked_at: 'is.null',
      limit: '1',
    })
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/google_drive_connections?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}`, apikey: config.supabasePublishableKey },
      })
    } catch {
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'TodayAction automation settings are temporarily unavailable.', true)
    }
    if (response.status === 401 || response.status === 403) throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction authentication is invalid or expired.', false)
    if (!response.ok) throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `TodayAction automation settings failed (HTTP ${response.status}).`, true)
    const rows = await response.json().catch(() => undefined) as AutomationRow[] | undefined
    if (!rows) throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction automation settings returned invalid data.', false)
    const row = rows[0]
    if (!row) throw new WorkspaceSourceError('GOOGLE_CONNECTION_REQUIRED', 'Connect Google to TodayAction before enabling background automation.', false)
    return row
  }

  async function responseStatus(row: AutomationRow, userId: string) {
    let discoveryReadiness: DiscoveryReadiness = { profileConfigured: null, budgetState: 'approval_required' }
    try { discoveryReadiness = await config.readDiscoveryReadiness?.(userId) ?? discoveryReadiness } catch { /* Keep unrelated Gmail status readable. */ }
    return { ...statusForRow(row), discoveryReadiness }
  }

  return async function handleAutomationSettings(request: Request) {
    const origin = request.headers.get('origin')
    if (request.method === 'OPTIONS') {
      const allowed = Boolean(origin && config.allowedOrigins.includes(origin))
      return new Response(null, { status: allowed ? 204 : 403, headers: corsHeaders(origin, config.allowedOrigins) })
    }
    if (!origin || !config.allowedOrigins.includes(origin)) {
      return json(403, { code: 'ORIGIN_NOT_ALLOWED', message: 'Automation settings are available only to an approved first-party TodayAction browser origin.' }, origin, config.allowedOrigins)
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' }, origin, config.allowedOrigins)
    }

    try {
      const { identity, accessToken } = await resolveIdentity(request)
      await config.authorizeIdentity?.(identity)
      const current = await readRow(identity.userId, accessToken)
      if (request.method === 'GET') return json(200, await responseStatus(current, identity.userId), origin, config.allowedOrigins)

      const body = await request.json().catch(() => undefined) as {
        action?: unknown
        gmailEnabled?: unknown
        gmailIntakeConsentVersion?: unknown
        discoveryEnabled?: unknown
      } | undefined
      if (body?.action === 'read') return json(200, await responseStatus(current, identity.userId), origin, config.allowedOrigins)

      const gmailProvided = Boolean(body && Object.prototype.hasOwnProperty.call(body, 'gmailEnabled'))
      const discoveryProvided = Boolean(body && Object.prototype.hasOwnProperty.call(body, 'discoveryEnabled'))
      if (!gmailProvided && !discoveryProvided) {
        return json(400, { code: 'INVALID_ARGUMENT', message: 'Provide gmailEnabled or discoveryEnabled.' }, origin, config.allowedOrigins)
      }
      if (gmailProvided && typeof body?.gmailEnabled !== 'boolean') {
        return json(400, { code: 'INVALID_ARGUMENT', message: 'gmailEnabled must be a boolean.' }, origin, config.allowedOrigins)
      }
      if (discoveryProvided && typeof body?.discoveryEnabled !== 'boolean') {
        return json(400, { code: 'INVALID_ARGUMENT', message: 'discoveryEnabled must be a boolean.' }, origin, config.allowedOrigins)
      }

      if (body?.gmailIntakeConsentVersion !== undefined && body.gmailIntakeConsentVersion !== 'uu06-v1') {
        return json(400, { code: 'INVALID_ARGUMENT', message: 'Unknown Gmail intake consent version.' }, origin, config.allowedOrigins)
      }
      const scopes = current.granted_scopes ?? []
      if (gmailProvided && body?.gmailEnabled === true && !scopes.includes(GMAIL_READONLY_SCOPE)) {
        return json(409, {
          code: 'GOOGLE_GMAIL_SCOPE_REQUIRED',
          message: 'Gmail read-only permission is required before recruiting-email automation can be enabled.',
        }, origin, config.allowedOrigins)
      }

      let gmailWatch: GmailWatchResult | undefined
      if (gmailProvided && body?.gmailEnabled === true && body.gmailIntakeConsentVersion === 'uu06-v1') {
        if (config.gmailExecutionControlsEnabled !== true) {
          return json(503, {
            code: 'GMAIL_EXECUTION_CONTROLS_REQUIRED',
            message: 'Gmail intake is not activated until fenced execution controls are enabled.',
          }, origin, config.allowedOrigins)
        }
        if ((config.gmailDeliveryMode ?? 'polling') === 'push') {
          if (!current.refresh_token_ciphertext) {
            throw new WorkspaceSourceError('AUTH_INVALID', 'Stored Google authorization is incomplete.', false)
          }
          gmailWatch = await (config.registerGmailWatchImpl ?? registerGmailWatch)({
            refreshTokenCiphertext: current.refresh_token_ciphertext,
            refreshLifecycle: googleRefreshLifecycle(config.tokenEncryptionKey ?? '', async (patch) => {
              const saved = await createGoogleConnectionStore({ supabaseUrl: config.supabaseUrl, publishableKey: config.supabasePublishableKey, fetchImpl })
                .updateRefreshState(identity.userId, accessToken, current.refresh_token_ciphertext!, patch)
              current.updated_at = saved.updatedAt
              if (patch.nextCiphertext) current.refresh_token_ciphertext = patch.nextCiphertext
            }),
            tokenEncryptionKey: config.tokenEncryptionKey ?? '',
            googleClientId: config.googleClientId ?? '',
            googleClientSecret: config.googleClientSecret ?? '',
            topicName: config.gmailPushTopicName ?? '',
            fetchImpl,
            now: config.now,
          })
        }
      }

      if (!current.updated_at) throw new WorkspaceSourceError('AUTH_INVALID', 'Google connection version is unavailable. Reload settings before changing them.', true)
      const params = new URLSearchParams({ user_id: `eq.${identity.userId}`, updated_at: `eq.${current.updated_at}`, revoked_at: 'is.null', select: 'user_id' })
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (gmailProvided) {
        patch.gmail_automation_enabled = body!.gmailEnabled
        // Reconnecting the same mailbox retains its durable cursor and pending
        // work. Explicit disable still revokes expanded intake consent; enabling
        // with a new consent version starts its appropriate backfill.
        const nextConsent = body!.gmailEnabled !== true ? null : body!.gmailIntakeConsentVersion === 'uu06-v1' ? 'uu06-v1' : current.gmail_intake_consent_version ?? null
        const consentChanged = body!.gmailEnabled === true && nextConsent !== (current.gmail_intake_consent_version ?? null)
        patch.gmail_intake_consent_version = nextConsent
        if (consentChanged || body!.gmailEnabled === false) {
          if (consentChanged) patch.gmail_history_id = null
          patch.gmail_sync_mode = null
          patch.gmail_page_token = null
          patch.gmail_pending_history_id = null
          patch.gmail_pending_message_ids = []
        }
        // A settings toggle is not proof that Google credentials became valid.
        // Only an explicit successful reconnect clears the persisted auth error.
        if (gmailWatch) {
          patch.gmail_watch_history_id = gmailWatch.historyId
          patch.gmail_watch_expires_at = gmailWatch.expiresAt
          patch.gmail_watch_last_renewed_at = gmailWatch.renewedAt
          patch.gmail_watch_last_error = null
        } else if ((config.gmailDeliveryMode ?? 'polling') === 'polling') {
          patch.gmail_watch_history_id = null
          patch.gmail_watch_expires_at = null
          patch.gmail_watch_last_renewed_at = null
          patch.gmail_watch_last_error = null
        }
      }
      if (discoveryProvided) {
        patch.discovery_automation_enabled = body!.discoveryEnabled
      }

      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}/rest/v1/google_drive_connections?${params.toString()}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: config.supabasePublishableKey,
            'content-type': 'application/json',
            Prefer: 'return=representation',
          },
          body: JSON.stringify(patch),
        })
      } catch {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'TodayAction automation settings could not be updated.', true)
      }
      if (!response.ok && gmailProvided) {
        const failure = await response.clone().json().catch(() => ({})) as { code?: string; message?: string }
        const missingConsentColumn = (failure.code === 'PGRST204' || failure.code === '42703')
          && Boolean(failure.message?.includes('gmail_intake_consent_version'))
        if (missingConsentColumn && patch.gmail_intake_consent_version === null) {
          // Pre-migration legacy enable/disable remains usable; compatibility must
          // never convert an expanded-consent request into an implicit legacy grant.
          const legacyPatch = { ...patch }; delete legacyPatch.gmail_intake_consent_version
          response = await fetchImpl(`${baseUrl}/rest/v1/google_drive_connections?${params.toString()}`, {
            method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, apikey: config.supabasePublishableKey,
              'content-type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(legacyPatch),
          })
        } else if (missingConsentColumn) {
          return json(409, { code: 'GMAIL_INTAKE_NOT_DEPLOYED', message: 'The expanded recruiting-email intake is not deployed yet. No expanded consent was saved.' }, origin, config.allowedOrigins)
        }
      }
      if (response.status === 401 || response.status === 403) throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction authentication is invalid or expired.', false)
      if (!response.ok) throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `TodayAction automation settings update failed (HTTP ${response.status}).`, true)

      const changed = await response.json().catch(() => undefined)
      if (!Array.isArray(changed) || changed.length !== 1 || changed[0]?.user_id !== identity.userId) {
        throw new WorkspaceSourceError('GOOGLE_CONNECTION_CHANGED', 'Google connection changed. Reload settings and retry.', true)
      }

      const updated: AutomationRow = { ...current, ...patch }
      if (discoveryProvided) {
        updated.discovery_automation_enabled = body!.discoveryEnabled as boolean
      }
      return json(200, await responseStatus(updated, identity.userId), origin, config.allowedOrigins)
    } catch (caught) {
      const error = caught instanceof WorkspaceSourceError
        ? { code: caught.code, message: caught.message, retryable: caught.retryable }
        : { code: 'AUTOMATION_SETTINGS_FAILED', message: caught instanceof Error ? caught.message : 'TodayAction automation settings failed.', retryable: false }
      const status = error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID' ? 401
        : error.code === 'GMAIL_PUSH_NOT_CONFIGURED' ? 503
        : error.retryable ? 503 : 400
      return json(status, error, origin, config.allowedOrigins)
    }
  }
}
