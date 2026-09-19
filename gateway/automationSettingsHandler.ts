import { GMAIL_READONLY_SCOPE } from './automationConnectionStore.js'
import { createSupabaseIdentityResolver } from './supabaseIdentity.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface AutomationSettingsHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  allowedOrigins: string[]
  fetchImpl?: typeof fetch
}

interface AutomationRow {
  user_id?: string
  google_email?: string | null
  granted_scopes?: string[] | null
  gmail_automation_enabled?: boolean | null
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
    discoveryLastSuccessAt: row.discovery_last_success_at ?? null,
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
        'google_email',
        'granted_scopes',
        'gmail_automation_enabled',
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
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'PJSDAS automation settings are temporarily unavailable.', true)
    }
    if (response.status === 401 || response.status === 403) throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS authentication is invalid or expired.', false)
    if (!response.ok) throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `PJSDAS automation settings failed (HTTP ${response.status}).`, true)
    const rows = await response.json().catch(() => undefined) as AutomationRow[] | undefined
    if (!rows) throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS automation settings returned invalid data.', false)
    const row = rows[0]
    if (!row) throw new WorkspaceSourceError('GOOGLE_CONNECTION_REQUIRED', 'Connect Google to PJSDAS before enabling background automation.', false)
    return row
  }

  return async function handleAutomationSettings(request: Request) {
    const origin = request.headers.get('origin')
    if (request.method === 'OPTIONS') {
      const allowed = Boolean(origin && config.allowedOrigins.includes(origin))
      return new Response(null, { status: allowed ? 204 : 403, headers: corsHeaders(origin, config.allowedOrigins) })
    }
    if (!origin || !config.allowedOrigins.includes(origin)) {
      return json(403, { code: 'ORIGIN_NOT_ALLOWED', message: 'Automation settings are available only to an approved first-party PJSDAS browser origin.' }, origin, config.allowedOrigins)
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' }, origin, config.allowedOrigins)
    }

    try {
      const { identity, accessToken } = await resolveIdentity(request)
      const current = await readRow(identity.userId, accessToken)
      if (request.method === 'GET') return json(200, statusForRow(current), origin, config.allowedOrigins)

      const body = await request.json().catch(() => undefined) as { gmailEnabled?: unknown; discoveryEnabled?: unknown } | undefined
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

      const scopes = current.granted_scopes ?? []
      if (gmailProvided && body?.gmailEnabled === true && !scopes.includes(GMAIL_READONLY_SCOPE)) {
        return json(409, {
          code: 'GOOGLE_GMAIL_SCOPE_REQUIRED',
          message: 'Gmail read-only permission is required before recruiting-email automation can be enabled.',
        }, origin, config.allowedOrigins)
      }

      const params = new URLSearchParams({ user_id: `eq.${identity.userId}` })
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (gmailProvided) {
        patch.gmail_automation_enabled = body!.gmailEnabled
        patch.gmail_sync_mode = null
        patch.gmail_page_token = null
        patch.gmail_pending_history_id = null
        patch.gmail_pending_message_ids = []
        if (body!.gmailEnabled === true) {
          patch.gmail_history_id = null
          patch.gmail_last_error = null
        }
      }
      if (discoveryProvided) {
        patch.discovery_automation_enabled = body!.discoveryEnabled
        if (body!.discoveryEnabled === true) patch.discovery_last_error = null
      }

      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}/rest/v1/google_drive_connections?${params.toString()}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: config.supabasePublishableKey,
            'content-type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(patch),
        })
      } catch {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'PJSDAS automation settings could not be updated.', true)
      }
      if (response.status === 401 || response.status === 403) throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS authentication is invalid or expired.', false)
      if (!response.ok) throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `PJSDAS automation settings update failed (HTTP ${response.status}).`, true)

      const updated: AutomationRow = { ...current }
      if (gmailProvided) {
        updated.gmail_automation_enabled = body!.gmailEnabled as boolean
        updated.gmail_sync_mode = null
        updated.gmail_page_token = null
        updated.gmail_pending_history_id = null
        updated.gmail_pending_message_ids = []
        if (body!.gmailEnabled === true) {
          updated.gmail_history_id = null
          updated.gmail_last_error = null
        }
      }
      if (discoveryProvided) {
        updated.discovery_automation_enabled = body!.discoveryEnabled as boolean
        if (body!.discoveryEnabled === true) updated.discovery_last_error = null
      }
      return json(200, statusForRow(updated), origin, config.allowedOrigins)
    } catch (caught) {
      const error = caught instanceof WorkspaceSourceError
        ? { code: caught.code, message: caught.message, retryable: caught.retryable }
        : { code: 'AUTOMATION_SETTINGS_FAILED', message: caught instanceof Error ? caught.message : 'PJSDAS automation settings failed.', retryable: false }
      const status = error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID' ? 401 : error.retryable ? 503 : 400
      return json(status, error, origin, config.allowedOrigins)
    }
  }
}
