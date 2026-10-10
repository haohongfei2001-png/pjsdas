import { describe, expect, it, vi } from 'vitest'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { discoveryReadinessLabel } from '../src/discoveryReadiness.js'
import { createDiscoveryReadinessReader } from '../gateway/discoveryReadinessReader.js'
const unknown = { profileConfigured: null, budgetState: 'approval_required' }
function reader(body: unknown, status = 200) {
 const fetchImpl = vi.fn(async () => Response.json(body, { status }))
 return { fetchImpl, read: createDiscoveryReadinessReader({ transactional: true, supabaseUrl: 'https://fixture.invalid', serviceRoleKey: 'synthetic-server', fetchImpl }) }
}
describe('truthful managed discovery readiness', () => {
 it('distinguishes disabled, unverified, unconfigured and no-budget states; never infers success from enabled', () => {
  expect(discoveryReadinessLabel({ verified: false, enabled: true }, true)).toBe('状态待核对')
  expect(discoveryReadinessLabel({ verified: true, enabled: false }, true)).toBe('未启用')
  expect(discoveryReadinessLabel({ verified: true, enabled: true }, true)).toBe('发现配置待核对')
  expect(discoveryReadinessLabel({ verified: true, enabled: true, readiness: { profileConfigured: false, budgetState: 'approval_required' } }, true)).toBe('待配置发现偏好')
  expect(discoveryReadinessLabel({ verified: true, enabled: true, readiness: { profileConfigured: true, budgetState: 'approval_required' } }, true)).toBe('待批准 TA 搜索预算')
 })
 it('reads only the exact verified account profile projection, not the complete workspace', async () => {
  const f = reader([{ user_id: 'owner-a', profile: createDefaultDiscoveryProfile() }])
  expect(await f.read('owner-a')).toEqual({ profileConfigured: false, scopeConfirmed: false, budgetState: 'approval_required' })
  const [url] = f.fetchImpl.mock.calls[0] as unknown as [string]
  const query = new URL(url).searchParams
  expect(query.get('select')).toBe('user_id,profile:snapshot->data->discoveryProfile')
  expect(query.get('user_id')).toBe('eq.owner-a')
 })
 it('a configured profile is still not an approved budget', async () => {
  const f = reader([{ user_id: 'owner-a', profile: { ...createDefaultDiscoveryProfile(), targetRoleQueries: ['Synthetic role'], searchScopeVersion: 1 } }])
  expect(await f.read('owner-a')).toEqual({ profileConfigured: true, scopeConfirmed: true, budgetState: 'approval_required' })
 })
 it('a historical configured profile still requires an explicit current scope confirmation', async () => {
  const f = reader([{ user_id: 'owner-a', profile: { ...createDefaultDiscoveryProfile(), targetRoleQueries: ['Synthetic role'] } }])
  const readiness = await f.read('owner-a')
  expect(readiness).toEqual({ profileConfigured: true, scopeConfirmed: false, budgetState: 'approval_required' })
  expect(discoveryReadinessLabel({ verified: true, enabled: true, readiness }, true)).toBe('待确认搜索范围')
 })
 it.each([[], [{user_id:'foreign',profile:null}], [{user_id:'owner-a',profile:'malformed'}], [{user_id:'owner-a',profile:{...createDefaultDiscoveryProfile(),targetRoleQueries:'wrong-type'}}]])('untrusted or absent account data stays unverified %#',async body=>{expect(await reader(body).read('owner-a')).toEqual(unknown)})
 it('verified missing profile is unconfigured, failed requests remain unknown',async()=>{
  expect(await reader([{user_id:'owner-a',profile:null}]).read('owner-a')).toEqual({...unknown,profileConfigured:false})
  expect(await reader({},503).read('owner-a')).toEqual(unknown)
 })
 it('no service credentials or nontransactional authority makes no request',async()=>{
  const fetchImpl=vi.fn()
  expect(await createDiscoveryReadinessReader({transactional:true,supabaseUrl:'https://fixture.invalid',serviceRoleKey:'',fetchImpl})('owner-a')).toEqual(unknown)
  expect(fetchImpl).not.toHaveBeenCalled()
 })
})
