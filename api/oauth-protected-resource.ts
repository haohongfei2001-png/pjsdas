const AUTHENTICATED_MCP_RESOURCE = 'https://pjsdas-remote-alpha.vercel.app/api/mcp-auth'
const AUTHORIZATION_SERVER = 'https://yyrzwpoxlxpafdlbkdtg.supabase.co/auth/v1'

export default {
  fetch() {
    return new Response(JSON.stringify({
      resource: AUTHENTICATED_MCP_RESOURCE,
      resource_name: 'PJSDAS read-only job-search data',
      authorization_servers: [AUTHORIZATION_SERVER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['email', 'profile'],
    }), {
      status: 200,
      headers: {
        'cache-control': 'public, max-age=300',
        'content-type': 'application/json; charset=utf-8',
      },
    })
  },
}
