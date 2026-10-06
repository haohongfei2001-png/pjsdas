import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { SCOPED_MANAGEMENT_CONSENTS, scopedManagementConsentHash, scopedManagementDomains } from '../gateway/scopedManagementConsent.js'
import { createScopedManagementConsentHandler } from '../gateway/scopedManagementConsentHandler.js'
import { createOwnerScopedManagementRuntime } from '../gateway/scopedManagementRuntime.js'
import { unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'

// Published bindings are independent of the current descriptor implementation.
// Neither edited display copy nor fixtures may silently replace these values.
const bindings = {
  business: [7, 'workspace.business.manage', '22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34'],
  opportunity: [3, 'workspace.opportunity.manage', 'cbd141fb716582ead3b578ab730ce0ac6e72d1dcdd93cb75c9cd0d1b734cc070'],
  planning: [4, 'workspace.planning.manage', '8d00011548bd7cd023b8993127be68a68b10c148a769b0ce66dc456b02590ee8'],
  discoveryProfile: [5, 'workspace.discovery-profile.manage', '2e101636a8d786162d7dafa04668a130ee2b09fb28e9c7135547faf8437ddcc8'],
  privateReminder: [6, 'workspace.reminders.manage', 'da1356a5e74914ccde6244432f6962e061464678bb75547f97d2de804aaddaa9'],
} as const
const owner = '00000000-0000-4000-8000-000000000001'
const client = '00000000-0000-4000-8000-000000000002'
const grantId = '00000000-0000-4000-8000-000000000003'
const origin = 'https://synthetic.invalid'
const planningGrant = { id: grantId, user_id: owner, client_id: client, capability: bindings.planning[1], consent_version: 4,
  consent_text_hash: bindings.planning[2], revision: 1, granted_at: '2026-10-01T00:00:00Z', revoked_at: null }

describe('immutable consent and deployed SQL bindings', () => {
  it.each(scopedManagementDomains)('keeps the published %s version, capability and complete text hash', async domain => {
    expect(SCOPED_MANAGEMENT_CONSENTS[domain]).toMatchObject({ version: bindings[domain][0], capability: bindings[domain][1] })
    expect(await scopedManagementConsentHash(domain)).toBe(bindings[domain][2])
  })

  it.each([
    ['20261003083410_scoped_management_consent_batch.sql', 4],
    ['20261003104723_consumer_business_scoped_access.sql', 5],
  ] as const)('matches every exact SQL scope binding in %s', async (file, count) => {
    const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')
    const rows = [...sql.matchAll(/when '([^']+)' then scope_capability:='([^']+)';scope_version:=(\d+);scope_hash:='([a-f0-9]{64})'/g)]
    expect(rows).toHaveLength(count)
    for (const [, domain, capability, version, hash] of rows) {
      const key = domain as keyof typeof bindings
      expect([Number(version), capability, hash]).toEqual(bindings[key])
      expect(await scopedManagementConsentHash(key)).toBe(hash)
    }
    expect(sql).toContain("choice->'consentVersion' is distinct from to_jsonb(scope_version)")
    expect(sql).toContain("choice->>'consentTextHash' is distinct from scope_hash")
  })

  it('accepts the existing v4 grant for factual reads but still rejects retired scoring and revoked grants', async () => {
    let revoked = false
    const snapshot = unknownDeadlineWorkspace(1)
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.method ?? 'GET').toBe('GET')
      const url = new URL(String(input))
      expect(url.searchParams.get('user_id')).toBe(`eq.${owner}`)
      if (url.pathname.endsWith('pjsdas_business_management_grants')) return Response.json(revoked ? [] : [planningGrant])
      expect(url.pathname).toBe('/rest/v1/pjsdas_workspaces')
      return Response.json([{ id: 'synthetic-workspace', user_id: owner, revision: 0, schema_version: 4, snapshot }])
    })
    const runtime = createOwnerScopedManagementRuntime({ enabled: 'enabled', transactional: true,
      identity: { userId: owner, oauthClientId: client }, audience: { mode: 'allowlist', allowed: true, role: 'owner' },
      supabaseUrl: origin, serviceRoleKey: 'fixture-only', fetchImpl })!
    expect((await runtime.planning!.invoke('get_planning_management', {})).structuredContent).toMatchObject({
      authorized: true, consentVersion: 4, data: { decisionRules: { status: 'retired', code: 'SCORING_RETIRED' } },
    })
    const command = { commandId: 'synthetic-retired-command', baseRevision: 0, change: { operations: [
      { kind: 'reset_decision_rules', expectedFingerprint: 'a'.repeat(64) },
    ] } }
    expect((await runtime.planning!.invoke('execute_planning_management', command)).structuredContent).toMatchObject({ code: 'SCORING_RETIRED' })
    revoked = true
    for (const [method, input] of [
      ['get_planning_management', {}], ['execute_planning_management', command],
      ['restore_planning_management', { commandId: 'synthetic-restore-command', targetCommandId: command.commandId, expectedCompensationFingerprint: 'a'.repeat(64) }],
    ] as const) expect((await runtime.planning!.invoke(method, input)).structuredContent).toMatchObject({ code: 'AUTH_FORBIDDEN' })
  })

  it.each(['approve', 'revoke'] as const)('submits %s using the unchanged v4 binding and rejects edited-copy hashes', async decision => {
    const posts: Record<string, any>[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/auth/v1/user') return Response.json({ id: owner })
      if (path === '/auth/v1/user/oauth/grants') return Response.json([{ client: { id: client, name: 'Synthetic' }, scopes: [], granted_at: '2026-10-01T00:00:00Z' }])
      expect(path).toBe('/rest/v1/rpc/pjsdas_decide_scoped_management_consent_v1')
      const body = JSON.parse(String(init?.body)); posts.push(body)
      expect(body.target_choices[0]).toMatchObject({ consentVersion: 4, consentTextHash: bindings.planning[2] })
      return Response.json([{ receipts: [{ domain: 'planning', outcome: decision === 'approve' ? 'APPROVED' : 'REVOKED', grant_id: grantId, grant_revision: decision === 'approve' ? 1 : 2 }] }])
    })
    const handler = createScopedManagementConsentHandler({ enabled: 'enabled', supabaseUrl: origin,
      supabasePublishableKey: 'fixture-only-public', serviceRoleKey: 'fixture-only', allowedOrigins: [origin],
      authorizeIdentity: async () => ({ allowed: true, mode: 'allowlist', role: 'owner' }), fetchImpl })
    const body = { requestId: '00000000-0000-4000-8000-000000000004', expectedAccountId: owner, clientId: client, confirmed: true,
      choices: [{ domain: 'planning', decision, consentVersion: 4, consentTextHash: bindings.planning[2], expectedGrant: decision === 'approve' ? null : { id: grantId, revision: 1 } }] }
    const request = (value: unknown) => new Request(`${origin}/api/workspace?surface=scoped-management-consent`, { method: 'POST',
      headers: { origin, authorization: `Bearer a.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.synthetic`, 'content-type': 'application/json' }, body: JSON.stringify(value) })
    expect((await handler(request(body))).status).toBe(200)
    expect(posts).toHaveLength(1)
    expect(posts[0].target_provider_client_verified).toBe(decision === 'approve')
    const changed = { ...body, choices: [{ ...body.choices[0], consentTextHash: '9dd2be40d3be6899926d961d4dd7d5cc66f87c47fc01c56c4eab31f282f14be3' }] }
    expect((await handler(request(changed))).status).toBe(409)
    expect(posts).toHaveLength(1)
  })
})
