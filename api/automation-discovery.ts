import { createDiscoveryAutomationHandler } from '../gateway/discoveryAutomationHandler.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'

const handler = createDiscoveryAutomationHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  tokenEncryptionKey: process.env.PJSDAS_TOKEN_ENCRYPTION_KEY ?? '',
  googleClientId: process.env.PJSDAS_GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.PJSDAS_GOOGLE_CLIENT_SECRET ?? '',
  // An explicitly configured deployment-owner API key takes precedence.
  // Otherwise resolve the project OIDC token at request time so PJSDAS does
  // not depend on VERCEL_OIDC_TOKEN being exposed as a static system env var.
  aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY,
  aiGatewayTokenProvider: async () => {
    const { getVercelOidcToken } = await import('@vercel/oidc')
    return getVercelOidcToken()
  },
  aiGatewayModel: process.env.PJSDAS_DISCOVERY_MODEL ?? 'perplexity/sonar',
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
