import { WorkspaceSourceError } from './workspaceSource'

export interface PjsdasIdentity {
  userId: string
  email?: string
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
    throw new WorkspaceSourceError('AUTH_REQUIRED', 'PJSDAS authentication is required.', false)
  }
  return match[1].trim()
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
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'PJSDAS identity service is temporarily unavailable.', true)
    }

    if (response.status === 401 || response.status === 403) {
      throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS authentication is invalid or expired.', false)
    }
    if (!response.ok) {
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `PJSDAS identity service failed (HTTP ${response.status}).`, true)
    }

    let data: { id?: string; email?: string }
    try {
      data = await response.json() as { id?: string; email?: string }
    } catch {
      throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS identity response is invalid.', false)
    }
    if (!data.id) throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS identity response has no user id.', false)

    return {
      identity: { userId: data.id, email: data.email },
      accessToken,
    }
  }
}
