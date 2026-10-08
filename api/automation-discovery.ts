import { createDiscoveryRuntime } from '../gateway/discoveryRuntime.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'

const handler = createDiscoveryRuntime({
  environment: process.env,
  base: {
    supabaseUrl: PJSDAS_SUPABASE_URL,
    supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
    supabaseServiceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
    tokenEncryptionKey: process.env.PJSDAS_TOKEN_ENCRYPTION_KEY ?? '',
    googleClientId: process.env.PJSDAS_GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: process.env.PJSDAS_GOOGLE_CLIENT_SECRET ?? '',
  },
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
