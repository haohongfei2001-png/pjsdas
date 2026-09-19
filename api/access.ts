import { createAudienceStatusHandler } from '../gateway/audienceStatusHandler.js'
import { firstPartyWebOrigins } from '../gateway/productionTopology.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'

const handler = createAudienceStatusHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  allowedOrigins: firstPartyWebOrigins(),
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
