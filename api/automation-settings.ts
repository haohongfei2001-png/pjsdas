import { createAutomationSettingsHandler } from '../gateway/automationSettingsHandler.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'
import { firstPartyWebOrigins } from '../gateway/productionTopology.js'

const handler = createAutomationSettingsHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  allowedOrigins: firstPartyWebOrigins(),
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
