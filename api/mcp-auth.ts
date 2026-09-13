import { backendUrl } from '../gateway/backendOrigin.js'

function hasBearerToken(request: Request) {
  const value = request.headers.get('authorization')?.trim() ?? ''
  return /^Bearer\s+\S+/i.test(value)
}

function unauthorized(request: Request) {
  return new Response(JSON.stringify({
    code: 'AUTH_REQUIRED',
    message: 'PJSDAS authentication is required.',
    retryable: false,
  }), {
    status: 401,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'WWW-Authenticate': `Bearer resource_metadata="${backendUrl('/.well-known/oauth-protected-resource', request)}"`,
    },
  })
}

export default {
  async fetch(request: Request) {
    // Keep the OAuth challenge at the outermost serverless boundary. This lets
    // MCP clients discover authorization without loading any real-data modules,
    // and guarantees unauthenticated requests fail closed before Drive code runs.
    if (!hasBearerToken(request)) return unauthorized(request)

    try {
      const { authenticatedRemoteMcpFetch } = await import('../gateway/authenticatedRemoteHttp.js')
      return await authenticatedRemoteMcpFetch(request)
    } catch {
      return new Response(JSON.stringify({
        code: 'TEMPORARILY_UNAVAILABLE',
        message: 'PJSDAS authenticated gateway is unavailable.',
        retryable: true,
      }), {
        status: 503,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
        },
      })
    }
  },
}
