import { backendUrl } from '../gateway/backendOrigin.js'
import { PJSDAS_SUPABASE_URL } from '../gateway/supabaseProject.js'

const AUTHORIZATION_SERVER = `${PJSDAS_SUPABASE_URL}/auth/v1`

export default {
  fetch(request?: Request) {
    return new Response(JSON.stringify({
      resource: backendUrl('/api/mcp', request),
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
