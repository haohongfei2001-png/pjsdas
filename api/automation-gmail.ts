import { createGmailAutomationHandler } from '../gateway/gmailAutomationHandler.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'

const handler = createGmailAutomationHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  tokenEncryptionKey: process.env.PJSDAS_TOKEN_ENCRYPTION_KEY ?? '',
  googleClientId: process.env.PJSDAS_GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.PJSDAS_GOOGLE_CLIENT_SECRET ?? '',
  executionControlsEnabled: process.env.PJSDAS_GMAIL_EXECUTION_CONTROLS === 'true',
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
