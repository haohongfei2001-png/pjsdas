import { createSupabaseIdentityResolver } from './supabaseIdentity'
import { encryptSecret } from './tokenCrypto'
import { WorkspaceSourceError } from './workspaceSource'

const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'

export interface GoogleLinkHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  tokenEncryptionKey: string
  allowedOrigins: string[]
  fetchImpl?: typeof fetch
}

type GoogleLinkRequestBody = {
  providerToken?: string
  providerRefreshToken?: string
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
    headers.set('access-control-allow-methods', 'POST, OPTIONS')
  }
  return headers
}

function json(status: number, body: unknown, origin: string | null, allowedOrigins: string[]) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin, allowedOrigins),
  })
}

function safeMessage(caught: unknown) {
  if (caught instanceof WorkspaceSourceError) {
    return { code: caught.code, message: caught.message, retryable: caught.retryable }
  }
  return {
    code: 'GOOGLE_LINK_FAILED',
    message: caught instanceof Error ? caught.message : 'PJSDAS could not save the Google Drive connection.',
    retryable: false,
  }
}

async function parseBody(request: Request): Promise<Required<GoogleLinkRequestBody>> {
  let body: GoogleLinkRequestBody
  try {
    body = await request.json() as GoogleLinkRequestBody
  } catch {
    throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Google link request body must be valid JSON.', false)
  }

  const providerToken = body.providerToken?.trim() ?? ''
  const providerRefreshToken = body.providerRefreshToken?.trim() ?? ''
  if (!providerToken || !providerRefreshToken) {
    throw new WorkspaceSourceError(
      'GOOGLE_CONNECTION_REQUIRED',
      'Google did not return the offline authorization required for PJSDAS AI access. Reconnect and approve access again.',
      false,
    )
  }
  return { providerToken, providerRefreshToken }
}

async function inspectGoogleToken(fetchImpl: typeof fetch, providerToken: string) {
  const params = new URLSearchParams({ access_token: providerToken })
  let response: Response
  try {
    response = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?${params.toString()}`, {
      headers: { accept: 'application/json' },
    })
  } catch {
    throw new WorkspaceSourceError('GOOGLE_DRIVE_UNAVAILABLE', 'Google authorization service is temporarily unavailable.', true)
  }

  let data: { sub?: string; email?: string; scope?: string; error?: string }
  try {
    data = await response.json() as { sub?: string; email?: string; scope?: string; error?: string }
  } catch {
    throw new WorkspaceSourceError('GOOGLE_AUTH_INVALID', 'Google returned an invalid authorization response.', false)
  }

  if (!response.ok || !data.sub) {
    throw new WorkspaceSourceError('GOOGLE_AUTH_INVALID', 'Google authorization is invalid or expired.', false)
  }

  const scopes = (data.scope ?? '').split(/\s+/).filter(Boolean)
  if (!scopes.includes(DRIVE_APPDATA_SCOPE)) {
    throw new WorkspaceSourceError(
      'GOOGLE_SCOPE_MISSING',
      'Google Drive appDataFolder permission was not granted. PJSDAS will not store this authorization.',
      false,
    )
  }

  return { subject: data.sub, email: data.email, scopes }
}

export function createGoogleLinkHandler(config: GoogleLinkHandlerConfig) {
  const fetchImpl = config.fetchImpl ?? fetch
  const resolveIdentity = createSupabaseIdentityResolver({
    supabaseUrl: config.supabaseUrl,
    publishableKey: config.supabasePublishableKey,
    fetchImpl,
  })

  return async function handleGoogleLink(request: Request) {
    const origin = request.headers.get('origin')

    if (request.method === 'OPTIONS') {
      const allowed = !origin || config.allowedOrigins.includes(origin)
      return new Response(null, {
        status: allowed ? 204 : 403,
        headers: corsHeaders(origin, config.allowedOrigins),
      })
    }

    if (request.method !== 'POST') {
      return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' }, origin, config.allowedOrigins)
    }

    if (origin && !config.allowedOrigins.includes(origin)) {
      return json(403, { code: 'ORIGIN_NOT_ALLOWED', message: 'This origin is not allowed to link Google Drive.' }, origin, config.allowedOrigins)
    }

    try {
      if (!config.tokenEncryptionKey.trim()) {
        throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'PJSDAS token encryption is not configured.', false)
      }

      const { identity, accessToken } = await resolveIdentity(request)
      const { providerToken, providerRefreshToken } = await parseBody(request)
      const google = await inspectGoogleToken(fetchImpl, providerToken)

      if (identity.email && google.email && identity.email.toLocaleLowerCase() !== google.email.toLocaleLowerCase()) {
        throw new WorkspaceSourceError(
          'GOOGLE_ACCOUNT_MISMATCH',
          'The Google Drive authorization does not match the Google account used to sign in to PJSDAS.',
          false,
        )
      }

      const ciphertext = await encryptSecret(providerRefreshToken, config.tokenEncryptionKey)
      const now = new Date().toISOString()
      const body = {
        user_id: identity.userId,
        google_subject: google.subject,
        google_email: google.email ?? identity.email ?? null,
        refresh_token_ciphertext: ciphertext,
        granted_scopes: google.scopes,
        connected_at: now,
        updated_at: now,
        revoked_at: null,
      }

      const params = new URLSearchParams({ on_conflict: 'user_id' })
      let response: Response
      try {
        response = await fetchImpl(`${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/google_drive_connections?${params.toString()}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: config.supabasePublishableKey,
            'content-type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(body),
        })
      } catch {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'PJSDAS authorization store is temporarily unavailable.', true)
      }

      if (response.status === 401 || response.status === 403) {
        throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS authentication is invalid or expired.', false)
      }
      if (!response.ok) {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `PJSDAS authorization store failed (HTTP ${response.status}).`, true)
      }

      return json(200, {
        status: 'connected',
        googleEmail: google.email ?? identity.email ?? null,
        scopes: [DRIVE_APPDATA_SCOPE],
      }, origin, config.allowedOrigins)
    } catch (caught) {
      const error = safeMessage(caught)
      const status = error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID' ? 401
        : error.code === 'ORIGIN_NOT_ALLOWED' ? 403
          : error.retryable ? 503
            : 400
      return json(status, error, origin, config.allowedOrigins)
    }
  }
}
