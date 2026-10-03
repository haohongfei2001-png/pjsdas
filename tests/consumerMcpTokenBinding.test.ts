import { afterEach, expect, it, vi } from 'vitest'
import { authenticatedRemoteMcpFetch } from '../gateway/authenticatedRemoteHttp.js'
import { validatedAccessTokenTargetsResource } from '../gateway/supabaseIdentity.js'

const owner = '00000000-0000-4000-8000-000000000001'
const client = '00000000-0000-4000-8000-000000000002'
const issuer = 'https://yyrzwpoxlxpafdlbkdtg.supabase.co/auth/v1'
const resource = 'https://todayaction.com/api/mcp'
const token = (overrides: Record<string, unknown>) => [
  { alg: 'RS256', typ: 'JWT' },
  { sub: owner, iss: issuer, client_id: client, aud: resource, exp: Math.floor(Date.now() / 1000) + 3600, ...overrides },
  'synthetic-signature',
].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

async function catalog(overrides: Record<string, unknown>, providerStatus = 200, enabled = true, tool?: string) {
  vi.stubEnv('PJSDAS_CANONICAL_API_ORIGIN', 'https://todayaction.com')
  vi.stubEnv('PJSDAS_CONSUMER_SCOPED_MANAGEMENT', enabled ? 'enabled' : '')
  vi.stubEnv('PJSDAS_OWNER_SCOPED_MANAGEMENT', '')
  vi.stubEnv('PJSDAS_OWNER_MANAGEMENT', '')
  vi.stubEnv('PJSDAS_AUDIENCE_MODE', 'allowlist')
  vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional')
  vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service')
  vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', 'synthetic-proposal')
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: owner }, { status: providerStatus })
    if (url.includes('/rest/v1/pjsdas_access_grants?')) return Response.json([{ user_id: owner, role: 'beta' }])
    if (url.includes('/rest/v1/pjsdas_authorization_grants?')) return Response.json([])
    throw new Error('Unexpected outbound request: ' + url)
  })
  vi.stubGlobal('fetch', fetchImpl)
  const response = await authenticatedRemoteMcpFetch(new Request('https://untrusted-host.invalid/api/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token(overrides)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': tool ? 'tools/call' : 'tools/list', ...(tool ? { 'Mcp-Name': tool } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: tool ? 'tools/call' : 'tools/list', params: { ...(tool ? { name: tool, arguments: {} } : {}), _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'synthetic', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
  }))
  const text = await response.text()
  const parsed = JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5) : text)
  return { response, text, parsed, names: parsed.result?.tools?.map((t: { name: string }) => t.name) ?? [], fetchImpl }
}

it('withholds every consumer scope from a provider-valid token for another resource', async () => {
  const { response, names, fetchImpl } = await catalog({ aud: 'https://other.invalid/api/mcp' })
  expect(response.status).toBe(200)
  expect(names).toContain('get_today_brief')
  for (const name of ['get_consumer_business_management', 'get_opportunity_management', 'get_planning_management', 'get_discovery_profile_management', 'get_private_reminder_management']) expect(names).not.toContain(name)
  expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('pjsdas_business_management_grants'))).toBe(true)
})

it.each(['get_consumer_business_management', 'execute_consumer_business_management', 'undo_consumer_business_management', 'get_planning_management'])('rejects a guessed direct %s call with the wrong audience before management data access', async tool => {
  const { text, parsed, fetchImpl } = await catalog({ aud: 'authenticated' }, 200, true, tool)
  expect(parsed.error || parsed.result?.isError).toBeTruthy()
  expect(text).not.toContain('authorized":true')
  expect(fetchImpl.mock.calls).toHaveLength(3)
})

it.each([resource, ['authenticated', resource]])('exposes consumer tools only after provider validation and exact resource binding (%j)', async aud => {
  const { names, fetchImpl } = await catalog({ aud })
  expect(names).toContain('get_consumer_business_management')
  expect(names).toContain('get_planning_management')
  expect(fetchImpl.mock.calls).toHaveLength(3)
})

it('does not promote resource-bound tokens when the feature is disabled', async () => {
  expect((await catalog({}, 200, false)).names).not.toContain('get_consumer_business_management')
})

it('never authenticates a decoded resource claim when the provider rejects the token', async () => {
  const { response, fetchImpl } = await catalog({}, 401)
  expect(response.status).toBe(401)
  expect(fetchImpl.mock.calls).toHaveLength(1)
})

it.each([
  { aud: 'authenticated' }, { aud: null }, { aud: [resource, 7] },
  { aud: 'https://untrusted-host.invalid/api/mcp' }, { aud: resource + '/' },
  { iss: 'https://other.invalid/auth/v1' }, { sub: 'other-account' },
  { client_id: undefined }, { client_id: owner }, { exp: undefined },
  { exp: '9999999999' }, { exp: 1 }, { nbf: 9999999999 }, { iat: 9999999999 },
])('denies malformed, foreign or inactive consumer token claims %j', claims => {
  expect(validatedAccessTokenTargetsResource(token(claims), { userId: owner, oauthClientId: client }, issuer, resource)).toBe(false)
})

it('cannot classify an opaque/malformed token as consumer resource authority', () => {
  for (const value of ['opaque', 'a.%%.c', 'a.bnVsbA.c']) expect(validatedAccessTokenTargetsResource(value, { userId: owner, oauthClientId: client }, issuer, resource)).toBe(false)
})
