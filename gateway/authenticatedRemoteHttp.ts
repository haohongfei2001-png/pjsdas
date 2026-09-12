import { createMcpHandler } from '@modelcontextprotocol/server'
import { createAuthenticatedDriveWorkspaceSource } from './authenticatedDriveSource.js'
import { createPjsdasMcpServer } from './serverFactory.js'
import { createSupabaseIdentityResolver } from './supabaseIdentity.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from './supabaseProject.js'
import { WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

export const AUTHENTICATED_GATEWAY_VERSION = '1.7.0-alpha.1' as const
export const AUTHENTICATED_MCP_RESOURCE = 'https://pjsdas-remote-alpha.vercel.app/api/mcp'
export const AUTHORIZATION_SERVER = `${PJSDAS_SUPABASE_URL}/auth/v1`
export const PROTECTED_RESOURCE_METADATA_URL = 'https://pjsdas-remote-alpha.vercel.app/.well-known/oauth-protected-resource'

function env(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', `PJSDAS server secret ${name} is not configured.`, false)
  return value
}

function unauthorized(message = 'PJSDAS authentication is required.') {
  return new Response(JSON.stringify({ code: 'AUTH_REQUIRED', message, retryable: false }), {
    status: 401,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'WWW-Authenticate': `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`,
    },
  })
}

function serviceError(caught: unknown) {
  if (caught instanceof WorkspaceSourceError) {
    if (caught.code === 'AUTH_REQUIRED' || caught.code === 'AUTH_INVALID') return unauthorized(caught.message)
    return new Response(JSON.stringify({ code: caught.code, message: caught.message, retryable: caught.retryable }), {
      status: caught.retryable ? 503 : 500,
      headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
    })
  }
  return new Response(JSON.stringify({ code: 'TEMPORARILY_UNAVAILABLE', message: 'PJSDAS authenticated gateway is unavailable.', retryable: true }), {
    status: 503,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
  })
}

function lazyDriveSource(request: Request): WorkspaceSource {
  return {
    async read() {
      const source = await createAuthenticatedDriveWorkspaceSource(request, {
        supabaseUrl: PJSDAS_SUPABASE_URL,
        supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
        tokenEncryptionKey: env('PJSDAS_TOKEN_ENCRYPTION_KEY'),
        googleClientId: env('PJSDAS_GOOGLE_CLIENT_ID'),
        googleClientSecret: env('PJSDAS_GOOGLE_CLIENT_SECRET'),
        timezone: 'Asia/Shanghai',
      })
      return source.read()
    },
  }
}

/**
 * Authenticated v1.7 runtime for real PJSDAS data.
 *
 * Existing source-backed discovery remains review-only. Continuous Discovery
 * records signed/reviewed discovery runs inside the existing ChangeSet audit
 * stream, then exposes an incremental baseline, source-coverage history, and a
 * deterministic posting-refresh queue through get_discovery_context. PJSDAS
 * still does not crawl or apply in the background. Application Portfolio and
 * Prep Graph remain deterministic read/projection layers over the same workspace.
 */
export async function authenticatedRemoteMcpFetch(request: Request) {
  try {
    const resolveIdentity = createSupabaseIdentityResolver({
      supabaseUrl: PJSDAS_SUPABASE_URL,
      publishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
    })
    await resolveIdentity(request)

    const source = lazyDriveSource(request)
    const handler = createMcpHandler(
      () => createPjsdasMcpServer(source, {
        version: AUTHENTICATED_GATEWAY_VERSION,
        dataMode: 'google-drive-readonly',
        proposalMode: 'review-link',
        proposalSigningKey: env('PJSDAS_TOKEN_ENCRYPTION_KEY'),
      }),
    )
    return handler.fetch(request)
  } catch (caught) {
    return serviceError(caught)
  }
}
