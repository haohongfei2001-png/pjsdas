import { createMcpHandler } from '@modelcontextprotocol/server'
import { createAuthenticatedDriveWorkspaceSource } from './authenticatedDriveSource.js'
import { createTransactionalWorkspaceSource } from './transactionalWorkspaceSource.js'
import { createAuthorizationGrantStore, grantAllows, type AuthorizationGrant } from './authorizationGrantStore.js'
import { createConfiguredAudienceAccessGuard } from './audienceAccess.js'
import { backendUrl } from './backendOrigin.js'
import { createPjsdasMcpServer } from './serverFactory.js'
import { defaultExternalCapabilityProbes } from './reminderTools.js'
import type { SemanticIntakeSourceRef } from '../src/model.js'
import { createSupabaseIdentityResolver } from './supabaseIdentity.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from './supabaseProject.js'
import {
  WorkspaceSourceError,
  type WorkspaceSource,
  type WorkspaceWriteInput,
} from './workspaceSource.js'

export const AUTHENTICATED_GATEWAY_VERSION = '1.10.0-alpha.1' as const
export const AUTHENTICATED_MCP_RESOURCE = backendUrl('/api/mcp')
export const AUTHORIZATION_SERVER = `${PJSDAS_SUPABASE_URL}/auth/v1`
export const PROTECTED_RESOURCE_METADATA_URL = backendUrl('/.well-known/oauth-protected-resource')

export function authenticatedMcpResource(request?: Request) {
  return backendUrl('/api/mcp', request)
}

export function protectedResourceMetadataUrl(request?: Request) {
  return backendUrl('/.well-known/oauth-protected-resource', request)
}

function env(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', `PJSDAS server secret ${name} is not configured.`, false)
  return value
}

function unauthorized(request: Request, message = 'PJSDAS authentication is required.') {
  return new Response(JSON.stringify({ code: 'AUTH_REQUIRED', message, retryable: false }), {
    status: 401,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'WWW-Authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(request)}"`,
    },
  })
}

function serviceError(caught: unknown, request: Request) {
  if (caught instanceof WorkspaceSourceError) {
    if (caught.code === 'AUTH_REQUIRED' || caught.code === 'AUTH_INVALID') return unauthorized(request, caught.message)
    const conflict = caught.code === 'WORKSPACE_CONFLICT'
    const forbidden = caught.code === 'AUTH_FORBIDDEN' || caught.code === 'AUDIENCE_ACCESS_REQUIRED' || caught.code === 'AUDIENCE_IDENTITY_MISMATCH'
    return new Response(JSON.stringify({ code: caught.code, message: caught.message, retryable: caught.retryable }), {
      status: forbidden ? 403 : conflict ? 409 : caught.retryable ? 503 : 500,
      headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    })
  }
  return new Response(JSON.stringify({ code: 'TEMPORARILY_UNAVAILABLE', message: 'PJSDAS authenticated gateway is unavailable.', retryable: true }), {
    status: 503,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
  })
}

async function authenticatedSource(request: Request) {
  return createAuthenticatedDriveWorkspaceSource(request, {
    supabaseUrl: PJSDAS_SUPABASE_URL,
    supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
    tokenEncryptionKey: env('PJSDAS_TOKEN_ENCRYPTION_KEY'),
    googleClientId: env('PJSDAS_GOOGLE_CLIENT_ID'),
    googleClientSecret: env('PJSDAS_GOOGLE_CLIENT_SECRET'),
    timezone: 'Asia/Shanghai',
  })
}

function lazyDriveSource(request: Request): WorkspaceSource {
  return {
    async read() {
      const source = await authenticatedSource(request)
      return source.read()
    },
    async write(input: WorkspaceWriteInput) {
      const source = await authenticatedSource(request)
      if (!source.write) throw new WorkspaceSourceError('WORKSPACE_READ_ONLY', 'Authenticated Drive workspace unexpectedly became read-only.', false)
      return source.write(input)
    },
  }
}

/**
 * Authenticated v1.9 runtime for the user's real PJSDAS Drive workspace.
 *
 * Read tools remain side-effect free. Every authenticated user may perform the
 * narrow additive add_opportunities write after an explicit current user command.
 * Review-only ChangeSets remain the path for policy, preference, ambiguous and
 * destructive changes. Autonomous trusted ingestion requires an explicit,
 * source-scoped authorization grant for the validated delegated OAuth client.
 * An OAuth client_id identifies the client; it is not itself an authorization.
 */
export async function authenticatedRemoteMcpFetch(request: Request) {
  try {
    const resolveIdentity = createSupabaseIdentityResolver({
      supabaseUrl: PJSDAS_SUPABASE_URL,
      publishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
    })
    const { identity, accessToken } = await resolveIdentity(request)
    await createConfiguredAudienceAccessGuard({ supabaseUrl: PJSDAS_SUPABASE_URL })(identity)
    let grants: AuthorizationGrant[] = []
    if (identity.oauthClientId) {
      const grantStore = createAuthorizationGrantStore({
        supabaseUrl: PJSDAS_SUPABASE_URL,
        publishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
      })
      grants = await grantStore.listActiveForClient(identity.userId, identity.oauthClientId, accessToken)
    }
    const discoveryIngestionEnabled = grants.some((grant) => grant.capability === 'ingest_discovery_run')
    const gmailIngestionEnabled = grants.some((grant) => grant.capability === 'ingest_gmail_run')
    const authorizeTrustedIngestion = async (name: 'ingest_discovery_run' | 'ingest_gmail_run', sourceId: string) => {
      if (!identity.oauthClientId || !grantAllows(grants, name, sourceId)) {
        throw new WorkspaceSourceError(
          'AUTH_FORBIDDEN',
          `This delegated client is not authorized for ${name} on source ${sourceId}.`,
          false,
        )
      }
    }
    const authorizeSemanticIntake = async (sourceRef: SemanticIntakeSourceRef) => {
      if (sourceRef.kind === 'mcp') return
      if (sourceRef.kind === 'web' && !identity.oauthClientId) return
      if (!identity.oauthClientId || !grantAllows(grants, 'semantic_intake', sourceRef.sourceId)) {
        throw new WorkspaceSourceError(
          'AUTH_FORBIDDEN',
          `This principal is not authorized for semantic_intake on source ${sourceRef.sourceId}.`,
          false,
        )
      }
    }

    const transactionalAuthority = process.env.PJSDAS_CONNECTED_AUTHORITY?.trim() === 'transactional'
    const externalCapabilities = defaultExternalCapabilityProbes()
    const source = transactionalAuthority
      ? createTransactionalWorkspaceSource({
          userId: identity.userId,
          supabaseUrl: PJSDAS_SUPABASE_URL,
          serviceRoleKey: env('PJSDAS_SUPABASE_SERVICE_ROLE_KEY'),
          principalKind: identity.oauthClientId ? 'delegated_mcp' : 'first_party_web',
          clientId: identity.oauthClientId,
          timezone: 'Asia/Shanghai',
        })
      : lazyDriveSource(request)
    const handler = createMcpHandler(
      () => createPjsdasMcpServer(source, {
        version: AUTHENTICATED_GATEWAY_VERSION,
        dataMode: transactionalAuthority ? 'transactional' : 'google-drive',
        proposalMode: 'review-link',
        // The authenticated production tool directory is release-stable.
        // Grants authorize calls inside invokeTrustedIngestion; they must never
        // make an advertised release tool disappear from tools/list/dispatcher.
        trustedIngestionMode: 'enabled',
        trustedIngestionCapabilities: {
          discovery: true,
          gmail: true,
        },
        trustedIngestionAuthorizer: authorizeTrustedIngestion,
        explicitUserWriteMode: 'enabled',
        explicitUserCommandMode: transactionalAuthority ? 'enabled' : 'disabled',
        semanticIntakeMode: transactionalAuthority ? 'enabled' : 'disabled',
        semanticIntakeAuthorizer: authorizeSemanticIntake,
        externalCapabilities,
        proposalSigningKey: env('PJSDAS_TOKEN_ENCRYPTION_KEY'),
      }),
    )
    return handler.fetch(request)
  } catch (caught) {
    return serviceError(caught, request)
  }
}
