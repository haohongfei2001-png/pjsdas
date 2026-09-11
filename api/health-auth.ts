import {
  AUTHENTICATED_GATEWAY_VERSION,
  AUTHENTICATED_MCP_RESOURCE,
  AUTHORIZATION_SERVER,
  PROTECTED_RESOURCE_METADATA_URL,
} from '../gateway/authenticatedRemoteHttp'

function configured(name: string) {
  return Boolean(process.env[name]?.trim())
}

export default {
  fetch() {
    const secrets = {
      tokenEncryptionKey: configured('PJSDAS_TOKEN_ENCRYPTION_KEY'),
      googleClientId: configured('PJSDAS_GOOGLE_CLIENT_ID'),
      googleClientSecret: configured('PJSDAS_GOOGLE_CLIENT_SECRET'),
    }
    const ready = Object.values(secrets).every(Boolean)

    return new Response(JSON.stringify({
      service: 'pjsdas-authenticated-mcp',
      version: AUTHENTICATED_GATEWAY_VERSION,
      mode: 'google-drive-readonly',
      auth: 'supabase-oauth-2.1',
      mcpResource: AUTHENTICATED_MCP_RESOURCE,
      authorizationServer: AUTHORIZATION_SERVER,
      protectedResourceMetadata: PROTECTED_RESOURCE_METADATA_URL,
      secretsConfigured: secrets,
      ready,
    }), {
      status: ready ? 200 : 503,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    })
  },
}
