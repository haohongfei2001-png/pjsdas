import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from './supabaseProject.js'

export interface ProductionSelfTestAuthOptions {
  accessToken?: string
  email?: string
  password?: string
  supabaseUrl?: string
  publishableKey?: string
  fetchImpl?: typeof fetch
}

export async function resolveProductionSelfTestAccessToken(
  options: ProductionSelfTestAuthOptions,
): Promise<string | undefined> {
  const explicitToken = options.accessToken?.trim()
  if (explicitToken) return explicitToken

  const email = options.email?.trim()
  const password = options.password?.trim()
  if (!email && !password) return undefined
  if (!email || !password) {
    throw new Error('PJSDAS production self-test requires both email and password when using a dedicated test identity.')
  }

  const supabaseUrl = (options.supabaseUrl ?? PJSDAS_SUPABASE_URL).replace(/\/+$/, '')
  const publishableKey = options.publishableKey ?? PJSDAS_SUPABASE_PUBLISHABLE_KEY
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })

  if (!response.ok) {
    throw new Error(`PJSDAS production self-test identity sign-in failed (HTTP ${response.status}).`)
  }

  const payload = await response.json() as { access_token?: string }
  const accessToken = payload.access_token?.trim()
  if (!accessToken) {
    throw new Error('PJSDAS production self-test identity sign-in returned no access token.')
  }
  return accessToken
}
