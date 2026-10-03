import * as z from 'zod/v4'
import { scopedConsentDomainSchema, type ScopedConsentDecision } from '../src/aiAccess/scopedConsentContract.js'
import { SCOPED_MANAGEMENT_CONSENTS, scopedManagementDomains } from './scopedManagementConsent.js'
import type { TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const grantSchema = z.object({ id: z.uuid(), user_id: z.uuid(), client_id: z.uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), revoked_at: z.iso.datetime({ offset: true }).nullable(), consent_version: z.number().int(), capability: z.string(), consent_text_hash: z.string().regex(/^[0-9a-f]{64}$/) })
const receiptSchema = z.array(z.object({ domain: scopedConsentDomainSchema, outcome: z.enum(['APPROVED', 'REVOKED', 'ALREADY_REVOKED', 'DENIED']), grant_id: z.uuid().nullable(), grant_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable() })).min(1).max(4)
const uncertain = () => new WorkspaceSourceError('CONSENT_OUTCOME_UNCONFIRMED', 'The decision may have committed. Read current state and retry only the same request ID and exact choices.', false)
export function createScopedManagementConsentStore(options: TransactionalWorkspaceStoreOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  async function request(path: string, init: RequestInit = {}) {
    if (!options.serviceRoleKey.trim()) throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Consent storage is not configured.', false)
    let response: Response
    try { response = await fetchImpl(`${options.supabaseUrl.replace(/\/+$/, '')}/rest/v1/${path}`, { ...init, headers: { authorization: `Bearer ${options.serviceRoleKey}`, apikey: options.serviceRoleKey, 'content-type': 'application/json' } }) }
    catch { if (init.method === 'POST') throw uncertain(); throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Consent state is temporarily unavailable.', true) }
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const code = body && typeof body === 'object' && 'code' in body ? body.code : undefined
      if (code === '40001' || code === '23505') throw new WorkspaceSourceError('CONSENT_CONFLICT', 'Consent changed or the request ID was reused. Read again before a new decision.', false)
      if (code === '42501' || code === '22023') throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Explicit consent binding is no longer valid.', false)
      if (init.method === 'POST') throw uncertain()
      throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'Consent state could not be read.', response.status >= 500 || response.status === 429)
    }
    return body
  }
  return {
    async list(userId: string) {
      const capabilities = scopedManagementDomains.map(domain => SCOPED_MANAGEMENT_CONSENTS[domain].capability)
      const query = new URLSearchParams({ select: 'id,user_id,client_id,revision,revoked_at,consent_version,capability,consent_text_hash', user_id: `eq.${userId}`, capability: `in.(${capabilities.join(',')})`, limit: '401' })
      const parsed = z.array(grantSchema).max(400).safeParse(await request(`pjsdas_business_management_grants?${query}`))
      if (!parsed.success) throw new WorkspaceSourceError('AUTH_INVALID', 'Consent state is invalid.', false)
      const seen = new Set<string>()
      return parsed.data.map(({ user_id, ...grant }) => {
        const domain = scopedManagementDomains.find(key => SCOPED_MANAGEMENT_CONSENTS[key].capability === grant.capability && SCOPED_MANAGEMENT_CONSENTS[key].version === grant.consent_version)
        const identity = `${grant.client_id}:${domain}`
        if (user_id !== userId || !domain || seen.has(identity)) throw new WorkspaceSourceError('AUTH_INVALID', 'Consent state does not match the current account or domain.', false)
        seen.add(identity)
        return { ...grant, domain }
      })
    },
    async decide(body: ScopedConsentDecision, requestHash: string, providerClientVerified: boolean, consumerEnabled = false, audienceMode: 'allowlist' | 'legacy' = 'allowlist') {
      const raw = await request('rpc/pjsdas_decide_scoped_management_consent_v1', { method: 'POST', body: JSON.stringify({ target_user_id: body.expectedAccountId, target_client_id: body.clientId, target_request_id: body.requestId, target_request_hash: requestHash, target_choices: body.choices, target_first_party: true, target_provider_client_verified: providerClientVerified, target_consumer_enabled: consumerEnabled, target_audience_mode: audienceMode }) })
      const parsed = z.array(z.object({ receipts: receiptSchema })).length(1).safeParse(raw)
      if (!parsed.success) throw uncertain()
      const receipts = parsed.data[0].receipts
      if (receipts.length !== body.choices.length || new Set(receipts.map(receipt => receipt.domain)).size !== receipts.length || receipts.some(receipt => !body.choices.some(choice => choice.domain === receipt.domain && (receipt.outcome === 'DENIED' || (choice.decision === 'approve' ? receipt.outcome === 'APPROVED' : receipt.outcome === 'REVOKED' || receipt.outcome === 'ALREADY_REVOKED'))))) throw uncertain()
      if (receipts.some(r => r.outcome === 'DENIED') ? !receipts.every(r => r.outcome === 'DENIED' && r.grant_id === null && r.grant_revision === null) : receipts.some(r => r.grant_id === null || r.grant_revision === null)) throw uncertain()
      return receipts
    },
  }
}
