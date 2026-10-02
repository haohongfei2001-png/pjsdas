import { describe, expect, it, vi } from 'vitest'
import {
  buildOwnerConsentDecision,
  createOwnerConsentClient,
  ownerConsentViewSchema,
  type OwnerConsentView,
} from '../src/aiAccess/ownerManagementConsentClient.js'
const owner = '00000000-0000-4000-8000-000000000001',
  clientId = '00000000-0000-4000-8000-000000000002',
  grantId = '00000000-0000-4000-8000-000000000003',
  requestId = '00000000-0000-4000-8000-000000000004'
const view: OwnerConsentView = {
  account: { id: owner, email: 'synthetic@example.invalid' },
  consent: {
    version: 2,
    capability: 'workspace.manage',
    title: 'Synthetic scope',
    scope: ['Independent preparation'],
    exclusions: ['No permanent deletion'],
    duration: 'Until revoked',
  },
  consentTextHash: 'a'.repeat(64),
  clients: [
    {
      id: clientId,
      name: 'Synthetic client',
      canApprove: true,
      grant: {
        id: grantId,
        client_id: clientId,
        revision: 3,
        revoked_at: null,
        consent_version: 2,
      },
    },
  ],
}
const session = { accountId: owner, accessToken: 'synthetic-session' }
const body = () =>
  buildOwnerConsentDecision(view, clientId, 'approve', true, requestId)
function fixture() {
  const getSession = vi.fn(async () => session)
  const request = vi.fn(async () => Response.json(view))
  return {
    getSession,
    request,
    client: createOwnerConsentClient({ getSession, request }),
  }
}
describe('owner consent UI contract client', () => {
  it('requires deliberate selection and confirmation and preserves exact identity/proof', () => {
    expect(() =>
      buildOwnerConsentDecision(view, clientId, 'approve', false, requestId),
    ).toThrow(/确认/)
    expect(() =>
      buildOwnerConsentDecision(view, owner, 'approve', true, requestId),
    ).toThrow(/确认/)
    const value = body()
    expect(value).toMatchObject({
      expectedAccountId: owner,
      clientId,
      requestId,
      consentVersion: 2,
      consentTextHash: view.consentTextHash,
      expectedGrant: { id: grantId, revision: 3 },
      confirmed: true,
    })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.expectedGrant)).toBe(true)
  })
  it('disconnected clients can only revoke existing active management grants', () => {
    const disconnected = structuredClone(view)
    disconnected.clients[0].canApprove = false
    expect(() =>
      buildOwnerConsentDecision(
        disconnected,
        clientId,
        'approve',
        true,
        requestId,
      ),
    ).toThrow()
    expect(
      buildOwnerConsentDecision(
        disconnected,
        clientId,
        'revoke',
        true,
        requestId,
      ).decision,
    ).toBe('revoke')
    disconnected.clients[0].grant!.revoked_at = '2026-10-02T00:00:00Z'
    expect(() =>
      buildOwnerConsentDecision(
        disconnected,
        clientId,
        'revoke',
        true,
        requestId,
      ),
    ).toThrow()
  })
  it('rejects duplicate or cross-client grant metadata', () => {
    expect(
      ownerConsentViewSchema.safeParse({
        ...view,
        clients: [...view.clients, ...view.clients],
      }).success,
    ).toBe(false)
    expect(
      ownerConsentViewSchema.safeParse({
        ...view,
        clients: [
          {
            ...view.clients[0],
            grant: { ...view.clients[0].grant, client_id: owner },
          },
        ],
      }).success,
    ).toBe(false)
  })
  it('checks the account both before and after an awaited read', async () => {
    const f = fixture()
    f.getSession
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce({ ...session, accountId: clientId })
    await expect(f.client.read()).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
    })
  })
  it('rejects a response for another account', async () => {
    const f = fixture()
    f.request.mockResolvedValue(
      Response.json({ ...view, account: { id: clientId } }),
    )
    await expect(f.client.read()).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
    })
  })
  it('requires matching displayed account immediately before POST', async () => {
    const f = fixture()
    f.getSession.mockResolvedValue({ ...session, accountId: clientId })
    await expect(f.client.decide(body())).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
    })
    expect(f.request).not.toHaveBeenCalled()
  })
  it('handles default-disabled surface and expired login without claiming authorization', async () => {
    const f = fixture()
    f.request
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
    await expect(f.client.read()).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
    })
    await expect(f.client.read()).rejects.toMatchObject({
      code: 'SIGN_IN_REQUIRED',
    })
  })
  it.each(['network', '503', 'malformed'])(
    'keeps %s POST outcomes uncertain and never retries automatically',
    async (fault) => {
      const f = fixture()
      if (fault === 'network')
        f.request.mockRejectedValue(new Error('lost response'))
      else
        f.request.mockResolvedValue(
          Response.json(
            { code: 'CONSENT_OUTCOME_UNCONFIRMED' },
            { status: fault === '503' ? 503 : 200 },
          ),
        )
      await expect(f.client.decide(body())).rejects.toMatchObject({
        uncertain: true,
      })
      expect(f.request).toHaveBeenCalledTimes(1)
    },
  )
  it('treats a known conflict as rejected, not a success or automatic new decision', async () => {
    const f = fixture()
    f.request.mockResolvedValue(
      Response.json({ code: 'CONSENT_CONFLICT' }, { status: 409 }),
    )
    await expect(f.client.decide(body())).rejects.toMatchObject({
      code: 'CONSENT_CONFLICT',
      uncertain: false,
    })
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it('retries only the exact supplied decision body and treats receipts as historical', async () => {
    const f = fixture()
    const receipt = {
      requestId,
      decision: 'approve',
      refreshRequired: true,
      receipt: { outcome: 'APPROVED', grant_id: grantId, grant_revision: 4 },
    }
    f.request
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json(receipt))
    const intent = body()
    await expect(f.client.decide(intent)).rejects.toMatchObject({
      uncertain: true,
    })
    expect(await f.client.decide(intent)).toEqual(receipt)
    expect(f.request.mock.calls[0][1]?.body).toBe(
      f.request.mock.calls[1][1]?.body,
    )
  })
})
