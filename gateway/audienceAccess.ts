import type { PjsdasIdentity } from './supabaseIdentity.js'
import { audienceMode, type PjsdasAudienceMode } from './productionTopology.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export type AudienceRole = 'owner' | 'beta' | 'legacy'

export interface AudienceAccessResult {
  mode: PjsdasAudienceMode
  allowed: boolean
  role?: AudienceRole
}

export interface AudienceAccessOptions {
  supabaseUrl: string
  serviceRoleKey?: string
  mode?: PjsdasAudienceMode
  fetchImpl?: typeof fetch
}

export function createAudienceAccessGuard(options: AudienceAccessOptions) {
  const mode = options.mode ?? audienceMode()
  const baseUrl = options.supabaseUrl.replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch

  return async function assertAudienceAccess(identity: PjsdasIdentity): Promise<AudienceAccessResult> {
    if (mode !== 'allowlist') return { mode, allowed: true, role: 'legacy' }

    const serviceRoleKey = options.serviceRoleKey?.trim()
    if (!serviceRoleKey) {
      throw new WorkspaceSourceError(
        'AUDIENCE_CONFIG_INVALID',
        'TodayAction allowlist mode is active but its server audience credential is not configured.',
        false,
      )
    }

    const params = new URLSearchParams({
      select: 'user_id,email,role,revoked_at',
      user_id: `eq.${identity.userId}`,
      revoked_at: 'is.null',
      limit: '1',
    })
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/pjsdas_access_grants?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
      })
    } catch {
      throw new WorkspaceSourceError('AUDIENCE_UNAVAILABLE', 'TodayAction audience authorization is temporarily unavailable.', true)
    }
    if (!response.ok) {
      throw new WorkspaceSourceError(
        'AUDIENCE_UNAVAILABLE',
        `TodayAction audience authorization failed (HTTP ${response.status}).`,
        response.status >= 500 || response.status === 429,
      )
    }

    const rows = await response.json().catch(() => undefined) as Array<{
      user_id?: string
      email?: string | null
      role?: string
    }> | undefined
    const row = rows?.[0]
    if (
      row?.user_id !== identity.userId
      || (row.role !== 'owner' && row.role !== 'beta')
    ) {
      throw new WorkspaceSourceError(
        'AUDIENCE_ACCESS_REQUIRED',
        'This TodayAction account is not in the controlled-production allowlist.',
        false,
      )
    }
    if (
      row.email
      && identity.email
      && row.email.toLocaleLowerCase() !== identity.email.toLocaleLowerCase()
    ) {
      throw new WorkspaceSourceError(
        'AUDIENCE_IDENTITY_MISMATCH',
        'The TodayAction audience grant does not match the authenticated account email.',
        false,
      )
    }

    return { mode, allowed: true, role: row.role }
  }
}

export function createConfiguredAudienceAccessGuard(options: {
  supabaseUrl: string
  fetchImpl?: typeof fetch
}) {
  return createAudienceAccessGuard({
    supabaseUrl: options.supabaseUrl,
    serviceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY,
    mode: audienceMode(),
    fetchImpl: options.fetchImpl,
  })
}
