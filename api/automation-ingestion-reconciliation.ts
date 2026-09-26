import { createIngestionDebtReconciliationHandler } from '../gateway/ingestionDebtReconciliationHandler.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'

const handler = createIngestionDebtReconciliationHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  supabaseServiceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
})

export default {
  fetch(request: Request) {
    return handler(request)
  },
}
