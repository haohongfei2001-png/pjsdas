import { createGoogleLinkHandler } from '../gateway/googleLinkHandler'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject'

const handler = createGoogleLinkHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  tokenEncryptionKey: process.env.PJSDAS_TOKEN_ENCRYPTION_KEY ?? '',
  allowedOrigins: [
    'https://haohongfei2001-png.github.io',
    'http://localhost:5173',
  ],
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
