import { createAutomationSettingsHandler } from '../gateway/automationSettingsHandler.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'
import { firstPartyWebOrigins } from '../gateway/productionTopology.js'
import { createConfiguredAudienceAccessGuard } from '../gateway/audienceAccess.js'

const handler = createAutomationSettingsHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  allowedOrigins: firstPartyWebOrigins(),
  tokenEncryptionKey: process.env.PJSDAS_TOKEN_ENCRYPTION_KEY ?? '',
  googleClientId: process.env.PJSDAS_GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.PJSDAS_GOOGLE_CLIENT_SECRET ?? '',
  gmailPushTopicName: process.env.PJSDAS_GMAIL_PUBSUB_TOPIC ?? '',
  authorizeIdentity: createConfiguredAudienceAccessGuard({ supabaseUrl: PJSDAS_SUPABASE_URL }),
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
