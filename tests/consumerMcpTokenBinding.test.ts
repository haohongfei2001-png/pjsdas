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

async function catalog(overrides: Record<string, unknown>, providerStatus = 200, enabled = true, tool?: string, admission: { configured?: boolean; marked?: boolean; role?: 'owner'|'beta' } = {}) {
  vi.stubEnv('PJSDAS_CONSUMER_TEST_ACCOUNT_IDS', admission.configured === false ? '' : owner+',00000000-0000-4000-8000-000000000009')
  vi.stubEnv('PJSDAS_CONSUMER_TEST_CLIENT_ID', client)
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
    if (url.includes('/rest/v1/pjsdas_access_grants?')) return Response.json([{ user_id: owner, role: admission.role ?? 'beta', ...(admission.marked ? { granted_at: new Date(Date.now()-1000).toISOString(), note: `TA_REVIEW_V7|${new Date(Date.now()+3600000).toISOString()}|00000000-0000-4000-8000-000000000081` } : {}) }])
    if (url.includes('/rest/v1/pjsdas_authorization_grants?')) return Response.json([])
    if (url.includes('/rest/v1/pjsdas_business_management_grants?')) return Response.json([])
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
  expect(response.status).toBe(404) // No tools are registered for this restricted principal.
  expect(names).toEqual([])
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
  expect(names).not.toContain('get_planning_management')
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

const onlyBusinessTools=['get_consumer_business_management','execute_consumer_business_management','undo_consumer_business_management']
it('advertises only v7 to selected consumers and never the legacy full-workspace surface',async()=>{
 const {names}=await catalog({})
 expect(names.sort()).toEqual([...onlyBusinessTools].sort())
})
it.each(['get_today_brief','get_prep_graph','list_opportunities','get_discovery_context','list_reminder_intents','add_opportunities','apply_user_command','semantic_intake','ingest_paia_input','resolve_semantic_decision','undo_semantic_command','propose_changes','get_business_management','execute_business_management','get_planning_management'])('denies cached or guessed legacy %s before any consumer workspace read/write',async tool=>{
 const {parsed,fetchImpl}=await catalog({},200,true,tool)
 expect(parsed.error || parsed.result?.isError).toBeTruthy()
 expect(fetchImpl.mock.calls).toHaveLength(3)
})
it('cannot fall back to old tools after flags or cohort configuration are removed',async()=>{
 for(const configured of [true,false]) {
  const {names}=await catalog({},200,false,undefined,{marked:true,configured})
  expect(names).toEqual([])
  const {parsed,fetchImpl}=await catalog({},200,false,'get_today_brief',{marked:true,configured})
  expect(parsed.error || parsed.result?.isError).toBeTruthy();expect(fetchImpl.mock.calls).toHaveLength(3)
 }
})
it('missing or revoked v7 consent returns only an authorization explanation, without workspace reads',async()=>{
 const {parsed,fetchImpl}=await catalog({},200,true,'get_consumer_business_management')
 expect(parsed.result.structuredContent).toMatchObject({authorized:false,consentVersion:7,reason:'EXPLICIT_CONSENT_REQUIRED'})
 expect(fetchImpl.mock.calls).toHaveLength(4)
 expect(fetchImpl.mock.calls.some(([url])=>String(url).includes('/pjsdas_workspaces'))).toBe(false)
})
it('preserves the existing 25-tool release surface for unmarked owners and other beta users',async()=>{
 for(const role of ['owner','beta'] as const){
  const {names}=await catalog({},200,false,undefined,{configured:false,role})
  expect(names).toHaveLength(25)
  for(const name of ['get_today_brief','get_prep_graph','apply_user_command','semantic_intake','propose_changes'])expect(names).toContain(name)
  for(const name of onlyBusinessTools)expect(names).not.toContain(name)
 }
})

it.each([{client_id:owner},{client_id:undefined}])('a consumer using another client or a first-party token cannot inherit old MCP access (%j)',async claims=>{
 const {names}=await catalog(claims)
 expect(names).toEqual([])
})
