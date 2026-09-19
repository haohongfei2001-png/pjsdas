import { createConnectedWorkspaceHandler } from '../gateway/connectedWorkspaceHandler.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'

const handler = createConnectedWorkspaceHandler({
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  serviceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
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
