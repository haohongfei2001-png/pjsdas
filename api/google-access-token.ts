import { createGoogleAccessTokenHandler } from '../gateway/googleAccessTokenHandler.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'
import { firstPartyWebOrigins } from '../gateway/productionTopology.js'
import { createConfiguredAudienceAccessGuard } from '../gateway/audienceAccess.js'

const handler = createGoogleAccessTokenHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  tokenEncryptionKey: process.env.PJSDAS_TOKEN_ENCRYPTION_KEY ?? '',
  googleClientId: process.env.PJSDAS_GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.PJSDAS_GOOGLE_CLIENT_SECRET ?? '',
  allowedOrigins: firstPartyWebOrigins(),
  authorizeIdentity: createConfiguredAudienceAccessGuard({ supabaseUrl: PJSDAS_SUPABASE_URL }),
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
