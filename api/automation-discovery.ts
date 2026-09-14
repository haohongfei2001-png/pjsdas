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
  // A plain provider/model string is intentionally used here. On Vercel the
  // AI SDK routes it through AI Gateway and owns project OIDC authentication;
  // AI_GATEWAY_API_KEY remains an operator-level fallback understood by the SDK.
  aiGatewayModel: process.env.PJSDAS_DISCOVERY_MODEL ?? 'perplexity/sonar',
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
