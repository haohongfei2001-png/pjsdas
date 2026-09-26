import { WorkspaceSourceError } from './workspaceSource.js'

export interface PjsdasIdentity {
  userId: string
  email?: string
  oauthClientId?: string
}

export interface SupabaseIdentityOptions {
  supabaseUrl: string
  publishableKey: string
  fetchImpl?: typeof fetch
}

function bearerToken(request: Request) {
  const value = request.headers.get('authorization')?.trim() ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(value)
  if (!match?.[1]?.trim()) {
    throw new WorkspaceSourceError('AUTH_REQUIRED', 'TodayAction authentication is required.', false)
  }
  return match[1].trim()
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> | undefined {
  const encodedPayload = accessToken.split('.')[1]
  if (!encodedPayload) return undefined
  try {
    const normalized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

export function oauthClientIdFromValidatedAccessToken(accessToken: string) {
  const value = decodeJwtPayload(accessToken)?.client_id
  if (typeof value !== 'string') return undefined
  const clientId = value.trim().toLocaleLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clientId)
    ? clientId
    : undefined
}

export function createSupabaseIdentityResolver(options: SupabaseIdentityOptions) {
  const baseUrl = options.supabaseUrl.replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch

  return async function resolveIdentity(request: Request): Promise<{ identity: PjsdasIdentity; accessToken: string }> {
    const accessToken = bearerToken(request)
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}/auth/v1/user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: options.publishableKey,
        },
      })
    } catch {
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'TodayAction identity service is temporarily unavailable.', true)
    }

    if (response.status === 401 || response.status === 403) {
      throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction authentication is invalid or expired.', false)
    }
    if (!response.ok) {
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `TodayAction identity service failed (HTTP ${response.status}).`, true)
    }

    let data: { id?: string; email?: string }
    try {
      data = await response.json() as { id?: string; email?: string }
    } catch {
      throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction identity response is invalid.', false)
    }
    if (!data.id) throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction identity response has no user id.', false)

    // Supabase has already validated the bearer token above. Only after that
    // verification may the OAuth-specific client_id claim influence capability
    // selection. Ordinary PJSDAS sessions do not carry this claim.
    const oauthClientId = oauthClientIdFromValidatedAccessToken(accessToken)

    return {
      identity: { userId: data.id, email: data.email, oauthClientId },
      accessToken,
    }
  }
}
