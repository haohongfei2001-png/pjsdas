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
  // Vercel documents VERCEL_OIDC_TOKEN as the Bearer credential for direct
  // HTTP AI Gateway clients. A deployment-owner API key, when configured,
  // intentionally takes precedence as the non-OIDC fallback.
  aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN,
  aiGatewayModel: process.env.PJSDAS_DISCOVERY_MODEL ?? 'perplexity/sonar',
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
