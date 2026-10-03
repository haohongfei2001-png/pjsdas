import { describe, expect, it, vi } from 'vitest'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createPjsdasMcpServer } from '../gateway/serverFactory.js'
import { createOwnerScopedManagementRuntime } from '../gateway/scopedManagementRuntime.js'
import { createConsumerBusinessManagementTools } from '../gateway/consumerBusinessManagementTools.js'
import { buildScopedConsentDecision, scopedConsentViewSchema } from '../src/aiAccess/scopedManagementConsentClient.js'
import { SCOPED_MANAGEMENT_CONSENTS, scopedManagementConsentHash, scopedManagementDomains } from '../gateway/scopedManagementConsent.js'

const owner = '00000000-0000-4000-8000-000000000001', client = '00000000-0000-4000-8000-000000000002'
const principal = { kind: 'delegated_mcp' as const, userId: owner, clientId: client }
const grant = { id: '00000000-0000-4000-8000-000000000003', revision: 1, userId: owner, clientId: client, consentVersion: 7 as const, capability: 'workspace.business.manage' as const, grantedAt: '2026-10-01T00:00:00Z' }

describe('distinct consumer business bridge', () => {
  it('requires explicit version7 selection and leaves the other scopes unselected', async () => {
    const view = scopedConsentViewSchema.parse({ account: { id: owner }, descriptors: await Promise.all(scopedManagementDomains.map(async domain => ({ domain, canApprove: domain !== 'business', consent: SCOPED_MANAGEMENT_CONSENTS[domain], consentTextHash: await scopedManagementConsentHash(domain) }))), clients: [{ id: client, name: 'Synthetic', canApprove: true, grants: [] }] })
    expect(() => buildScopedConsentDecision(view, client, { business: 'approve' }, true, grant.id)).toThrow()
    view.descriptors.find(d => d.domain === 'business')!.canApprove = true
    const decision = buildScopedConsentDecision(view, client, { business: 'approve' }, true, grant.id)
    expect(decision.choices).toEqual([{ domain: 'business', decision: 'approve', consentVersion: 7, consentTextHash: await scopedManagementConsentHash('business'), expectedGrant: null }])
    expect(() => buildScopedConsentDecision(view, client, {}, true, grant.id)).toThrow()
  })
  it.each([2, undefined])('refuses a legacy or unversioned undo receipt (%s)', async version => {
    const undo = vi.fn(), lookup = vi.fn(async () => ({ found: true, operation: 'business_management', receipt: { managementAuthorization: { consentVersion: version } } }))
    const tools = createConsumerBusinessManagementTools({ principal, source: { read: async () => { throw new Error('Unexpected data read') } }, resolveGrant: async () => grant, createExecutor: () => ({ lookup, undo } as any) })
    expect((await tools.invoke('undo_consumer_business_management', { commandId: 'synthetic-consumer-undo', targetCommandId: 'synthetic-owner-command' })).structuredContent).toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(undo).not.toHaveBeenCalled()
  })
  it('refuses a legacy owner grant before workspace reads or executor construction', async () => {
    const read = vi.fn(), createExecutor = vi.fn()
    const tools = createConsumerBusinessManagementTools({ principal, source: { read }, resolveGrant: async () => ({ ...grant, consentVersion: 2, capability: 'workspace.manage' } as any), createExecutor })
    for (const [name, input] of [['get_consumer_business_management', {}], ['execute_consumer_business_management', {}], ['undo_consumer_business_management', {}]] as const) expect((await tools.invoke(name, input)).structuredContent).toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(read).not.toHaveBeenCalled(); expect(createExecutor).not.toHaveBeenCalled()
  })
  it('advertises three separate tools only with the consumer flag; catalog reads never grant access', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json([])), source = { read: vi.fn(async () => { throw new Error('Unexpected workspace access') }) }
    const options = { enabled: 'enabled', transactional: true, identity: { userId: owner, oauthClientId: client }, audience: { mode: 'allowlist' as const, role: 'owner' as const, allowed: true }, supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl }
    const catalog = async (consumerEnabled?: string) => {
      const handler = createMcpHandler(() => createPjsdasMcpServer(source, { scopedManagement: createOwnerScopedManagementRuntime({ ...options, consumerEnabled }) }))
      const response = await handler.fetch(new Request('https://synthetic.invalid/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'synthetic', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) }))
      const body = await response.text(); return JSON.parse(body.startsWith('event:') ? body.split('\n').find(x => x.startsWith('data:'))!.slice(5) : body).result.tools
    }
    const absent = await catalog(), present = await catalog('enabled')
    expect(present).toHaveLength(absent.length + 3)
    for (const name of ['get_consumer_business_management', 'execute_consumer_business_management', 'undo_consumer_business_management']) {
      expect(absent.some((t: any) => t.name === name)).toBe(false)
      expect(present.find((t: any) => t.name === name).annotations.openWorldHint).toBe(false)
    }
    expect(fetchImpl).not.toHaveBeenCalled(); expect(source.read).not.toHaveBeenCalled()
  })
})
