import { createMcpHandler } from '@modelcontextprotocol/server'
import { createAuthenticatedDriveWorkspaceSource } from './authenticatedDriveSource.js'
import { createPjsdasMcpServer } from './serverFactory.js'
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

export const AUTHENTICATED_GATEWAY_VERSION = '1.9.0-alpha.1' as const
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
    const conflict = caught.code === 'WORKSPACE_CONFLICT'
    return new Response(JSON.stringify({ code: caught.code, message: caught.message, retryable: caught.retryable }), {
      status: conflict ? 409 : caught.retryable ? 503 : 500,
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
 * Read tools remain side-effect free. Review-only ChangeSets remain the path for
 * policy, preference, ambiguous and destructive changes. The only autonomous
 * mutations exposed here are bounded trusted-source ingestion batches
 * (GPT-monitor and structured Gmail facts). Those writes are idempotent,
 * reconciliation-accounted, and guarded by exact Drive workspace versions.
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
        dataMode: 'google-drive',
        proposalMode: 'review-link',
        trustedIngestionMode: 'enabled',
        proposalSigningKey: env('PJSDAS_TOKEN_ENCRYPTION_KEY'),
      }),
    )
    return handler.fetch(request)
  } catch (caught) {
    return serviceError(caught)
  }
}
