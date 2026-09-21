import { createGmailAutomationHandler } from '../gateway/gmailAutomationHandler.js'
import { createGmailPushHandler } from '../gateway/gmailPushHandler.js'
import { createGmailWatchHandler } from '../gateway/gmailWatchHandler.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'

const automationHandler = createGmailAutomationHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  tokenEncryptionKey: process.env.PJSDAS_TOKEN_ENCRYPTION_KEY ?? '',
  googleClientId: process.env.PJSDAS_GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.PJSDAS_GOOGLE_CLIENT_SECRET ?? '',
  executionControlsEnabled: process.env.PJSDAS_GMAIL_EXECUTION_CONTROLS === 'true',
})

const watchHandler = createGmailWatchHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  tokenEncryptionKey: process.env.PJSDAS_TOKEN_ENCRYPTION_KEY ?? '',
  googleClientId: process.env.PJSDAS_GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.PJSDAS_GOOGLE_CLIENT_SECRET ?? '',
  topicName: process.env.PJSDAS_GMAIL_PUBSUB_TOPIC ?? '',
})

const pushHandler = createGmailPushHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  supabaseServiceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
  expectedAudience: process.env.PJSDAS_GMAIL_PUSH_AUDIENCE ?? '',
  expectedServiceAccountEmail: process.env.PJSDAS_GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL ?? '',
  expectedSubscription: process.env.PJSDAS_GMAIL_PUBSUB_SUBSCRIPTION ?? '',
})

export const gmailAutomationApi = { fetch: automationHandler }
export const gmailWatchApi = { fetch: watchHandler }
export const gmailPushApi = { fetch: pushHandler }

export default {
  fetch(request: Request) {
    const route = new URL(request.url).searchParams.get('__pjsdas_gmail_route')
    if (route === 'push') return pushHandler(request)
    if (route === 'watch') return watchHandler(request)
    return automationHandler(request)
  },
}
