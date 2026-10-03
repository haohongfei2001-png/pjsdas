import { describe, expect, it, vi } from 'vitest'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createOwnerScopedManagementRuntime } from '../gateway/scopedManagementRuntime.js'
import { createScopedManagementGrantReader } from '../gateway/scopedManagementGrantStore.js'
import { SCOPED_MANAGEMENT_CONSENTS, scopedManagementConsentHash, scopedManagementDomains } from '../gateway/scopedManagementConsent.js'
import { createPjsdasMcpServer } from '../gateway/serverFactory.js'
import { unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'

const owner = '00000000-0000-4000-8000-000000000001', client = '00000000-0000-4000-8000-000000000002'
const principal = { kind: 'delegated_mcp' as const, userId: owner, clientId: client }
const options = () => ({ enabled: 'enabled', transactional: true, identity: { userId: owner, oauthClientId: client }, audience: { mode: 'allowlist' as const, allowed: true, role: 'owner' as const }, supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl: vi.fn<typeof fetch>(async () => Response.json([])) })
const request = (method: string, params: Record<string, unknown> = {}) => new Request('https://synthetic.invalid/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'synthetic', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) })
async function payload(response: Response) { const body = await response.text(); return JSON.parse(body.startsWith('event:') ? body.split('\n').find(line => line.startsWith('data:'))!.slice(5) : body) }

describe('scoped management admission', () => {
  it('freezes each complete descriptor, including user-visible nested scopes', async () => {
    expect(Object.isFrozen(SCOPED_MANAGEMENT_CONSENTS)).toBe(true)
    const hashes = []
    for (const domain of scopedManagementDomains) {
      const descriptor = SCOPED_MANAGEMENT_CONSENTS[domain]
      expect(Object.isFrozen(descriptor)).toBe(true)
      expect(Object.isFrozen(descriptor.scope)).toBe(true)
      expect(Object.isFrozen(descriptor.exclusions)).toBe(true)
      hashes.push(await scopedManagementConsentHash(domain))
    }
    expect(new Set(hashes).size).toBe(4)
  })
  it.each(scopedManagementDomains)('requires exact %s account, client, domain, version and descriptor hash', async domain => {
    const o = options(), d = SCOPED_MANAGEMENT_CONSENTS[domain]
    const row = { id: '00000000-0000-4000-8000-000000000003', user_id: owner, client_id: client, capability: d.capability, consent_version: d.version, consent_text_hash: await scopedManagementConsentHash(domain), revision: 1, granted_at: '2026-10-01T00:00:00Z', revoked_at: null }
    const reader = createScopedManagementGrantReader(domain, o)
    o.fetchImpl.mockResolvedValueOnce(Response.json([row]))
    expect(await reader(principal)).toMatchObject({ capability: d.capability, consentVersion: d.version })
    const url = new URL(String(o.fetchImpl.mock.calls[0][0]))
    expect(url.searchParams.get('user_id')).toBe(`eq.${owner}`)
    expect(url.searchParams.get('client_id')).toBe(`eq.${client}`)
    expect(url.searchParams.get('capability')).toBe(`eq.${d.capability}`)
    expect(url.searchParams.get('consent_version')).toBe(`eq.${d.version}`)
    for (const override of [{ user_id: client }, { client_id: owner }, { capability: 'workspace.manage', consent_version: 2 }, { consent_text_hash: '0'.repeat(64) }, { revision: 0 }, { revoked_at: '2026-10-01T00:00:00Z' }, { granted_at: '2099-01-01T00:00:00Z' }]) {
      o.fetchImpl.mockResolvedValueOnce(Response.json([{ ...row, ...override }]))
      await expect(reader(principal)).rejects.toThrow()
    }
    o.fetchImpl.mockResolvedValueOnce(Response.json([row, row]))
    await expect(reader(principal)).rejects.toThrow()
    o.fetchImpl.mockResolvedValueOnce(Response.json([]))
    expect(await reader(principal)).toBeUndefined()
    o.fetchImpl.mockClear()
    expect(await reader({ kind: 'first_party_web', userId: owner })).toBeUndefined()
    expect(o.fetchImpl).not.toHaveBeenCalled()
  })
  it.each([{ enabled: undefined }, { enabled: 'true' }, { transactional: false }, { identity: { userId: owner } }, { audience: { mode: 'public', allowed: true, role: 'legacy' } }, { audience: { mode: 'allowlist', allowed: true, role: 'beta' } }])('stays disabled before any network access %#', override => {
    const o = options(); expect(createOwnerScopedManagementRuntime({ ...o, ...override } as typeof o)).toBeUndefined(); expect(o.fetchImpl).not.toHaveBeenCalled()
  })
  it.each(scopedManagementDomains)('withholds %s data when the admitted grant changes during the read', async domain => {
    const d = SCOPED_MANAGEMENT_CONSENTS[domain], snapshot = unknownDeadlineWorkspace(1)
    const row = { id: '00000000-0000-4000-8000-000000000003', user_id: owner, client_id: client, capability: d.capability, consent_version: d.version, consent_text_hash: await scopedManagementConsentHash(domain), revision: 1, granted_at: '2026-10-01T00:00:00Z', revoked_at: null }
    for (const mode of ['revoke', 'revision', 'replacement']) {
      const o = options(); let reads = 0
      o.fetchImpl.mockImplementation(async input => {
        if (String(input).includes('/pjsdas_business_management_grants?')) {
          reads++
          return Response.json(reads === 1 ? [row] : mode === 'revoke' ? [] : [{ ...row, ...(mode === 'revision' ? { revision: 2 } : { id: '00000000-0000-4000-8000-000000000004' }) }])
        }
        expect(String(input)).toContain('/pjsdas_workspaces?')
        return Response.json([{ id: 'synthetic-workspace', user_id: owner, revision: 0, schema_version: 4, snapshot }])
      })
      const runtime = createOwnerScopedManagementRuntime(o)!
      const result = domain === 'opportunity' ? await runtime.opportunity.invoke('get_opportunity_management', { opportunityId: snapshot.data.opportunities[0].id })
        : domain === 'planning' ? await runtime.planning.invoke('get_planning_management', {})
          : domain === 'discoveryProfile' ? await runtime.discoveryProfile.invoke('get_discovery_profile_management', {})
            : await runtime.privateReminder.invoke('get_private_reminder_management', { type: 'reminders' })
      expect(reads, `${domain}/${mode}: ${JSON.stringify(result)}`).toBe(2)
      expect(result.structuredContent).toMatchObject({ code: 'AUTH_FORBIDDEN' })
      expect(result.structuredContent).not.toHaveProperty('data')
    }
  })
  it('registers twelve exact tools without data access; ungranted calls never reach a workspace', async () => {
    const o = options(), source = { read: vi.fn(async () => { throw new Error('unexpected workspace read') }) }
    const runtime = createOwnerScopedManagementRuntime(o)!
    const disabled = createMcpHandler(() => createPjsdasMcpServer(source))
    const explicitOff = createMcpHandler(() => createPjsdasMcpServer(source, { scopedManagement: undefined }))
    const baseline = await payload(await disabled.fetch(request('tools/list')))
    expect((await payload(await explicitOff.fetch(request('tools/list')))).result).toEqual(baseline.result)
    const enabled = createMcpHandler(() => createPjsdasMcpServer(source, { scopedManagement: runtime }))
    const catalog = (await payload(await enabled.fetch(request('tools/list')))).result.tools
    for (const tool of catalog) {
      expect(typeof tool.annotations.readOnlyHint).toBe('boolean')
      expect(typeof tool.annotations.destructiveHint).toBe('boolean')
      expect(tool.annotations.openWorldHint).toBe(false)
    }
    const names = catalog.map((tool: { name: string }) => tool.name)
    expect(names.length).toBe(baseline.result.tools.length + 12)
    expect(new Set(names).size).toBe(names.length)
    expect(o.fetchImpl).not.toHaveBeenCalled()
    for (const domain of ['opportunity', 'planning', 'discovery_profile', 'private_reminder']) {
      for (const action of ['get', 'execute', 'restore']) expect(names).toContain(`${action}_${domain}_management`)
      const result = await payload(await enabled.fetch(request('tools/call', { name: `get_${domain}_management`, arguments: domain === 'opportunity' ? { opportunityId: 'synthetic' } : domain === 'private_reminder' ? { type: 'reminders' } : {} })))
      expect(result.result.isError).toBe(true)
      expect(result.result.structuredContent, JSON.stringify(result)).toMatchObject({ code: 'AUTH_FORBIDDEN' })
    }
    expect(source.read).not.toHaveBeenCalled()
    expect(o.fetchImpl).toHaveBeenCalledTimes(4)
    for (const [url, init] of o.fetchImpl.mock.calls) { expect(String(url)).toContain('/pjsdas_business_management_grants?'); expect(init?.method ?? 'GET').toBe('GET') }
  })
  it.each([{mode:'allowlist' as const,allowed:true,role:'beta' as const},{mode:'legacy' as const,allowed:true,role:'legacy' as const}])('admits consumer catalogue only under its separate explicit source flag %#', audience=>{
    const o={...options(),audience};expect(createOwnerScopedManagementRuntime(o)).toBeUndefined();expect(createOwnerScopedManagementRuntime({...o,consumerEnabled:'enabled'})).toBeDefined();expect(createOwnerScopedManagementRuntime({...o,consumerEnabled:'enabled',audience:{...audience,allowed:false}})).toBeUndefined();expect(o.fetchImpl).not.toHaveBeenCalled()
  })

})
