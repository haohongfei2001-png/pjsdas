import { createConfiguredAudienceAccessGuard } from './audienceAccess.js'
import { audienceMode } from './productionTopology.js'
import { createSupabaseIdentityResolver } from './supabaseIdentity.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface AudienceStatusHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  allowedOrigins: string[]
  fetchImpl?: typeof fetch
}

function headers(origin: string | null, allowedOrigins: string[]) {
  const value = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    vary: 'Origin',
  })
  if (origin && allowedOrigins.includes(origin)) {
    value.set('access-control-allow-origin', origin)
    value.set('access-control-allow-headers', 'authorization, content-type')
    value.set('access-control-allow-methods', 'GET, OPTIONS')
  }
  return value
}

function json(status: number, body: unknown, origin: string | null, allowedOrigins: string[]) {
  return new Response(JSON.stringify(body), { status, headers: headers(origin, allowedOrigins) })
}

export function createAudienceStatusHandler(config: AudienceStatusHandlerConfig) {
  const resolveIdentity = createSupabaseIdentityResolver({
    supabaseUrl: config.supabaseUrl,
    publishableKey: config.supabasePublishableKey,
    fetchImpl: config.fetchImpl,
  })
  const guard = createConfiguredAudienceAccessGuard({
    supabaseUrl: config.supabaseUrl,
    fetchImpl: config.fetchImpl,
  })

  return async function handleAudienceStatus(request: Request) {
    const origin = request.headers.get('origin')
    if (request.method === 'OPTIONS') {
      const allowed = Boolean(origin && config.allowedOrigins.includes(origin))
      return new Response(null, { status: allowed ? 204 : 403, headers: headers(origin, config.allowedOrigins) })
    }
    if (request.method !== 'GET') return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' }, origin, config.allowedOrigins)
    if (!origin || !config.allowedOrigins.includes(origin)) {
      return json(403, { code: 'ORIGIN_NOT_ALLOWED', message: 'Audience status is available only to an approved first-party PJSDAS browser origin.' }, origin, config.allowedOrigins)
    }

    try {
      const { identity } = await resolveIdentity(request)
      try {
        const result = await guard(identity)
        return json(200, {
          authenticated: true,
          allowed: result.allowed,
          mode: result.mode,
          role: result.role ?? null,
          email: identity.email ?? null,
        }, origin, config.allowedOrigins)
      } catch (caught) {
        if (caught instanceof WorkspaceSourceError && (
          caught.code === 'AUDIENCE_ACCESS_REQUIRED' || caught.code === 'AUDIENCE_IDENTITY_MISMATCH'
        )) {
          return json(200, {
            authenticated: true,
            allowed: false,
            mode: audienceMode(),
            role: null,
            email: identity.email ?? null,
            reason: caught.code,
          }, origin, config.allowedOrigins)
        }
        throw caught
      }
    } catch (caught) {
      const error = caught instanceof WorkspaceSourceError
        ? caught
        : new WorkspaceSourceError('AUDIENCE_STATUS_FAILED', caught instanceof Error ? caught.message : 'Audience status failed.', false)
      const status = error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID' ? 401
        : error.retryable ? 503
          : 400
      return json(status, { code: error.code, message: error.message, retryable: error.retryable }, origin, config.allowedOrigins)
    }
  }
}
