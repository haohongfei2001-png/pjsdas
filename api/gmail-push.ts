import { createGmailPushHandler } from '../gateway/gmailPushHandler.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'

const handler = createGmailPushHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  supabaseServiceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
  expectedAudience: process.env.PJSDAS_GMAIL_PUSH_AUDIENCE ?? '',
  expectedServiceAccountEmail: process.env.PJSDAS_GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL ?? '',
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
