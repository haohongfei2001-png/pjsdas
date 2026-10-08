import { WorkspaceSourceError, type DiscoveryCommitAuthorization } from './workspaceSource.js'

export type TrustedIngestionCapability = 'ingest_discovery_run' | 'ingest_gmail_run' | 'semantic_intake'

export interface AuthorizationGrant {
  id?: string
  revision?: number
  grantedAt?: string
  userId: string
  clientId: string
  sourceId: string
  capability: TrustedIngestionCapability
}

export interface AuthorizationGrantStoreOptions {
  supabaseUrl: string
  publishableKey: string
  fetchImpl?: typeof fetch
}

export function createAuthorizationGrantStore(options: AuthorizationGrantStoreOptions) {
  const baseUrl = options.supabaseUrl.replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    async listActiveForClient(userId: string, clientId: string, userAccessToken: string): Promise<AuthorizationGrant[]> {
      const params = new URLSearchParams({
        select: 'id,revision,user_id,client_id,source_id,capability,granted_at,revoked_at',
        user_id: `eq.${userId}`,
        client_id: `eq.${clientId}`,
        revoked_at: 'is.null',
      })

      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}/rest/v1/pjsdas_authorization_grants?${params.toString()}`, {
          headers: {
            Authorization: `Bearer ${userAccessToken}`,
            apikey: options.publishableKey,
          },
        })
      } catch {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'TodayAction authorization grants are temporarily unavailable.', true)
      }

      if (response.status === 401 || response.status === 403) {
        throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction delegated authorization is invalid or expired.', false)
      }
      if (!response.ok) {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `TodayAction authorization grant lookup failed (HTTP ${response.status}).`, true)
      }

      let rows: Array<{
        user_id?: string
        client_id?: string
        source_id?: string
        capability?: string
        id?: string
        revision?: number
        granted_at?: string
        revoked_at?: string | null
      }>
      try {
        rows = await response.json()
      } catch {
        throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction authorization grant response is invalid.', false)
      }

      return rows.flatMap((row) => {
        if (
          row.user_id !== userId
          || row.client_id !== clientId
          || !row.source_id
          || typeof row.capability !== 'string'
          || !['ingest_discovery_run', 'ingest_gmail_run', 'semantic_intake'].includes(row.capability)
          || row.revoked_at != null
        ) return []
        return [{
          userId,
          clientId,
          sourceId: row.source_id,
          capability: row.capability as TrustedIngestionCapability,
          id: row.id,
          revision: row.revision,
          grantedAt: row.granted_at,
        }]
      })
    },
  }
}

export function grantAllows(
  grants: AuthorizationGrant[],
  capability: TrustedIngestionCapability,
  sourceId: string,
) {
  return grants.some((grant) => grant.capability === capability && grant.sourceId === sourceId)
}

/** One tool invocation keeps its first admission even across fresh permission
 * checks. Regrant/replacement cannot authorize work retrieved under an old row. */
export function createDiscoveryGrantAdmission(userId: string, clientId: string, now: () => number = Date.now) {
  const admissions = new Map<string, Extract<DiscoveryCommitAuthorization, { kind: 'delegated_mcp' }>>()
  return (grants: AuthorizationGrant[], sourceId: string) => {
    const matches = grants.filter(grant => grant.userId === userId && grant.clientId === clientId
      && grant.capability === 'ingest_discovery_run' && grant.sourceId === sourceId)
    const grant = matches.length === 1 ? matches[0] : undefined
    if (!grant?.id || !/^[0-9a-f-]{36}$/i.test(grant.id) || !Number.isSafeInteger(grant.revision) || grant.revision! < 1
      || !grant.grantedAt || !Number.isFinite(Date.parse(grant.grantedAt)) || Date.parse(grant.grantedAt) > now()) {
      throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Discovery requires an exact current version of its existing source grant.', false)
    }
    const proof = Object.freeze({ kind: 'delegated_mcp' as const, userId, clientId, sourceId, grantId: grant.id, grantRevision: grant.revision! })
    const admitted = admissions.get(sourceId)
    if (admitted && (admitted.grantId !== proof.grantId || admitted.grantRevision !== proof.grantRevision)) {
      throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'The admitted Discovery grant was revoked, replaced or changed.', false)
    }
    if (!admitted) admissions.set(sourceId, proof)
    return admitted ?? proof
  }
}
