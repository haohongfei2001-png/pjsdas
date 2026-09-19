import { WorkspaceSourceError } from './workspaceSource.js'

export type TrustedIngestionCapability = 'ingest_discovery_run' | 'ingest_gmail_run'

export interface AuthorizationGrant {
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
        select: 'user_id,client_id,source_id,capability,revoked_at',
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
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'PJSDAS authorization grants are temporarily unavailable.', true)
      }

      if (response.status === 401 || response.status === 403) {
        throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS delegated authorization is invalid or expired.', false)
      }
      if (!response.ok) {
        throw new WorkspaceSourceError('AUTH_UNAVAILABLE', `PJSDAS authorization grant lookup failed (HTTP ${response.status}).`, true)
      }

      let rows: Array<{
        user_id?: string
        client_id?: string
        source_id?: string
        capability?: string
      }>
      try {
        rows = await response.json()
      } catch {
        throw new WorkspaceSourceError('AUTH_INVALID', 'PJSDAS authorization grant response is invalid.', false)
      }

      return rows.flatMap((row) => {
        if (
          row.user_id !== userId
          || row.client_id !== clientId
          || !row.source_id
          || (row.capability !== 'ingest_discovery_run' && row.capability !== 'ingest_gmail_run')
        ) return []
        return [{
          userId,
          clientId,
          sourceId: row.source_id,
          capability: row.capability,
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
