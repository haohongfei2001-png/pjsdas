import { expect, test } from '@playwright/test'
import { createOwnerManagementConsentHandler } from '../gateway/ownerManagementConsentHandler.js'

// Real browser transport -> actual server handler, with synthetic provider only.
// No credentials or requests leave the loopback fixture.
test('same-origin browser GET omits Origin and still reaches the authenticated consent read', async ({ page }) => {
  const owner = '00000000-0000-4000-8000-000000000001'
  const token = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.synthetic`
  const origin = 'http://127.0.0.1:4173'
  const seen: Array<{ method: string; origin?: string }> = []
  let providerReads = 0
  const handler = createOwnerManagementConsentHandler({
    enabled: 'enabled', supabaseUrl: 'https://provider.invalid', supabasePublishableKey: 'fixture', serviceRoleKey: 'fixture', allowedOrigins: [origin],
    authorizeIdentity: async () => ({ allowed: true, mode: 'allowlist', role: 'owner' }),
    fetchImpl: async (input, init) => {
      expect(init?.method ?? 'GET').toBe('GET')
      providerReads++
      const path = new URL(String(input)).pathname
      if (path === '/auth/v1/user') return Response.json({ id: owner })
      if (path === '/auth/v1/user/oauth/grants' || path.endsWith('/pjsdas_business_management_grants')) return Response.json([])
      throw new Error('Unexpected fixture request')
    },
  })
  await page.route('**/*', async route => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/__consent-origin-page') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Consent transport fixture</title>' })
    if (url.pathname !== '/__consent-origin-probe') return route.continue()
    const headers = await req.allHeaders()
    seen.push({ method: req.method(), origin: headers.origin })
    const response = await handler(new Request(req.url(), { method: req.method(), headers, body: req.postData() ?? undefined }))
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
  })
  await page.goto(`${origin}/__consent-origin-page`)
  const result = await page.evaluate(async ({ token }) => {
    const response = await fetch('/__consent-origin-probe', { headers: { authorization: `Bearer ${token}` } })
    return { status: response.status, body: await response.json() }
  }, { token })
  expect(seen).toEqual([{ method: 'GET', origin: undefined }])
  expect(result.status).toBe(200)
  expect(result.body.account.id).toBe(owner)
  expect(providerReads).toBe(3)
  const anonymous = await page.evaluate(async () => {
    const response = await fetch('/__consent-origin-probe')
    return { status: response.status, body: await response.json() }
  })
  expect(anonymous).toMatchObject({ status: 401, body: { code: 'AUTH_REQUIRED' } })
  expect(providerReads).toBe(3)
})
