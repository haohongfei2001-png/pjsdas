import { PJSDAS_SUPABASE_URL } from '../gateway/supabaseProject'

export default {
  fetch() {
    return Response.json({ ok: true, url: PJSDAS_SUPABASE_URL })
  },
}
