import googleAccessToken from '../api/google-access-token.js'
import googleLink from '../api/google-link.js'
import health from '../api/health.js'
import healthAuth from '../api/health-auth.js'
import mcp from '../api/mcp.js'
import mcpAuth from '../api/mcp-auth.js'
import oauthProtectedResource from '../api/oauth-protected-resource.js'
import proposalVerify from '../api/proposal-verify.js'
import type { ReleaseIdentityEnvironment } from '../gateway/releaseIdentity.js'

type FetchHandler = { fetch(request: Request): Response | Promise<Response> }

const ROUTES = new Map<string, FetchHandler>([
  ['/api/google-access-token', googleAccessToken],
  ['/api/google-link', googleLink],
  ['/api/health-auth', healthAuth],
  ['/api/mcp', mcp],
  ['/api/mcp-auth', mcpAuth],
  ['/api/oauth-protected-resource', oauthProtectedResource],
  ['/api/proposal-verify', proposalVerify],
  ['/.well-known/oauth-protected-resource', oauthProtectedResource],
  ['/.well-known/oauth-protected-resource/api/mcp-auth', oauthProtectedResource],
])

export async function routeCloudflareRequest(request: Request, environment?: ReleaseIdentityEnvironment) {
  const path = new URL(request.url).pathname.replace(/\/$/, '') || '/'
  if (path === '/api/health') return health.fetch(request, environment)

  const handler = ROUTES.get(path)
  if (!handler) {
    return new Response(JSON.stringify({
      code: 'NOT_FOUND',
      message: 'PJSDAS backend route not found.',
    }), {
      status: 404,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    })
  }
  return handler.fetch(request)
}

export default {
  fetch(request: Request, environment?: ReleaseIdentityEnvironment) {
    return routeCloudflareRequest(request, environment)
  },
}
