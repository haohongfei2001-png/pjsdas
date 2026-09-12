import { createGoogleConnectionStore } from './googleConnectionStore.js'
import { refreshGoogleAccessToken } from './googleOAuthTokens.js'
import { createSupabaseIdentityResolver } from './supabaseIdentity.js'
import { decryptSecret } from './tokenCrypto.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface GoogleAccessTokenHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  allowedOrigins: string[]
  fetchImpl?: typeof fetch
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

function safeError(caught: unknown) {
  if (caught instanceof WorkspaceSourceError) {
    return { code: caught.code, message: caught.message, retryable: caught.retryable }
  }
  return {
    code: 'GOOGLE_ACCESS_TOKEN_FAILED',
    message: caught instanceof Error ? caught.message : 'PJSDAS could not restore Google Drive authorization.',
    retryable: false,
  }
}

export function createGoogleAccessTokenHandler(config: GoogleAccessTokenHandlerConfig) {
  const fetchImpl = config.fetchImpl ?? fetch
  const resolveIdentity = createSupabaseIdentityResolver({
    supabaseUrl: config.supabaseUrl,
    publishableKey: config.supabasePublishableKey,
    fetchImpl,
  })
  const connections = createGoogleConnectionStore({
    supabaseUrl: config.supabaseUrl,
    publishableKey: config.supabasePublishableKey,
    fetchImpl,
  })

  return async function handleGoogleAccessToken(request: Request) {
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
      return json(403, { code: 'ORIGIN_NOT_ALLOWED', message: 'This origin is not allowed to restore Google Drive access.' }, origin, config.allowedOrigins)
    }

    try {
      if (!config.tokenEncryptionKey.trim() || !config.googleClientId.trim() || !config.googleClientSecret.trim()) {
        throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'PJSDAS Google authorization is not configured.', false)
      }

      const { identity, accessToken: pjsdasAccessToken } = await resolveIdentity(request)
      const binding = await connections.readForUser(identity.userId, pjsdasAccessToken)
      const refreshToken = await decryptSecret(binding.refreshTokenCiphertext, config.tokenEncryptionKey)
      const accessToken = await refreshGoogleAccessToken(refreshToken, {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        fetchImpl,
      })

      return json(200, {
        accessToken,
        expiresInSeconds: 3000,
        googleEmail: binding.googleEmail ?? identity.email ?? null,
      }, origin, config.allowedOrigins)
    } catch (caught) {
      const error = safeError(caught)
      const status = error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID' ? 401
        : error.code === 'ORIGIN_NOT_ALLOWED' ? 403
          : error.code === 'GOOGLE_CONNECTION_REQUIRED' || error.code === 'GOOGLE_AUTH_EXPIRED' ? 409
            : error.retryable ? 503
              : 400
      return json(status, error, origin, config.allowedOrigins)
    }
  }
}
