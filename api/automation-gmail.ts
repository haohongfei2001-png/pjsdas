import { createGmailAutomationHandler } from '../gateway/gmailAutomationHandler.js'
import { PJSDAS_SUPABASE_URL } from '../gateway/supabaseProject.js'

const handler = createGmailAutomationHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  serviceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
  tokenEncryptionKey: process.env.PJSDAS_TOKEN_ENCRYPTION_KEY ?? '',
  googleClientId: process.env.PJSDAS_GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.PJSDAS_GOOGLE_CLIENT_SECRET ?? '',
  automationSecret: process.env.PJSDAS_AUTOMATION_SECRET ?? process.env.CRON_SECRET ?? '',
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
