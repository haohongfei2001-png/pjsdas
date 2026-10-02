import * as z from 'zod/v4'
import { fetchBackend } from '../backendEndpoints.js'
const grantSchema = z.object({
  id: z.uuid(),
  client_id: z.uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revoked_at: z.string().nullable(),
  consent_version: z.literal(2),
})
export const ownerConsentViewSchema = z
  .object({
    account: z.object({ id: z.uuid(), email: z.string().optional() }),
    consent: z.object({
      version: z.literal(2),
      capability: z.literal('workspace.manage'),
      title: z.string().min(1).max(300),
      scope: z.array(z.string().min(1).max(500)).min(1).max(10),
      exclusions: z.array(z.string().min(1).max(500)).min(1).max(10),
      duration: z.string().min(1).max(500),
    }),
    consentTextHash: z.string().regex(/^[0-9a-f]{64}$/),
    clients: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string().min(1).max(500),
            canApprove: z.boolean(),
            grant: grantSchema.nullable(),
          })
          .refine((c) => !c.grant || c.grant.client_id === c.id),
      )
      .max(100),
  })
  .refine((v) => new Set(v.clients.map((c) => c.id)).size === v.clients.length)
export type OwnerConsentView = z.infer<typeof ownerConsentViewSchema>
export interface OwnerConsentDecision {
  requestId: string
  expectedAccountId: string
  clientId: string
  decision: 'approve' | 'revoke'
  consentVersion: 2
  consentTextHash: string
  expectedGrant: { id: string; revision: number } | null
  confirmed: true
}
export interface OwnerConsentSession {
  accountId: string
  accessToken: string
}
export class OwnerConsentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly uncertain = false,
  ) {
    super(message)
  }
}
export function buildOwnerConsentDecision(
  view: OwnerConsentView,
  clientId: string,
  decision: 'approve' | 'revoke',
  confirmed: boolean,
  requestId: string,
): OwnerConsentDecision {
  const client = view.clients.find((c) => c.id === clientId)
  if (
    !confirmed ||
    !client ||
    (decision === 'approve' && !client.canApprove) ||
    (decision === 'revoke' && (!client.grant || client.grant.revoked_at))
  )
    throw new OwnerConsentError(
      'CONFIRMATION_REQUIRED',
      '请先确认当前账号、客户端和本次操作。',
    )
  return Object.freeze({
    requestId,
    expectedAccountId: view.account.id,
    clientId,
    decision,
    consentVersion: 2,
    consentTextHash: view.consentTextHash,
    expectedGrant: client.grant
      ? Object.freeze({ id: client.grant.id, revision: client.grant.revision })
      : null,
    confirmed: true,
  })
}
export function createOwnerConsentClient(options: {
  getSession: () => Promise<OwnerConsentSession | null>
  request?: typeof fetchBackend
}) {
  const request = options.request ?? fetchBackend
  async function session(expected?: string) {
    const value = await options.getSession()
    if (!value)
      throw new OwnerConsentError(
        'SIGN_IN_REQUIRED',
        '请使用当前 TodayAction 账号登录。',
      )
    if (expected && value.accountId !== expected)
      throw new OwnerConsentError(
        'ACCOUNT_CHANGED',
        '账号已切换，请重新读取并确认。',
      )
    return value
  }
  const uncertain = () =>
    new OwnerConsentError(
      'CONSENT_OUTCOME_UNCONFIRMED',
      '操作可能已经完成。请先重新读取状态，只能重试同一请求；关闭页面不会撤销授权。',
      true,
    )
  return {
    async read(): Promise<OwnerConsentView> {
      const current = await session()
      const response = await request(
        '/api/workspace?surface=owner-management-consent',
        { headers: { authorization: `Bearer ${current.accessToken}` } },
      )
      if (response.status === 404)
        throw new OwnerConsentError(
          'CAPABILITY_DISABLED',
          '扩展管理尚未启用。现有 TodayAction 插件核心工具仍可使用。',
        )
      if (response.status === 401)
        throw new OwnerConsentError(
          'SIGN_IN_REQUIRED',
          '登录已过期，请重新登录 TodayAction。',
        )
      if (!response.ok)
        throw new OwnerConsentError(
          'READ_FAILED',
          '无法读取当前授权状态，请稍后重新读取。',
        )
      const parsed = ownerConsentViewSchema.safeParse(
        await response.json().catch(() => undefined),
      )
      if (!parsed.success || parsed.data.account.id !== current.accountId)
        throw new OwnerConsentError(
          'ACCOUNT_CHANGED',
          '授权页面与当前账号不一致，请重新读取。',
        )
      await session(current.accountId)
      return parsed.data
    },
    async decide(body: OwnerConsentDecision) {
      const current = await session(body.expectedAccountId)
      let response: Response
      try {
        response = await request(
          '/api/workspace?surface=owner-management-consent',
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${current.accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          },
        )
      } catch {
        throw uncertain()
      }
      const payload: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const code =
          payload && typeof payload === 'object' && 'code' in payload
            ? payload.code
            : undefined
        if (response.status >= 500 || code === 'CONSENT_OUTCOME_UNCONFIRMED')
          throw uncertain()
        throw new OwnerConsentError(
          typeof code === 'string' ? code : 'DECISION_REJECTED',
          '授权未获确认。请重新读取当前状态后再明确选择。',
        )
      }
      const parsed = z
        .object({
          requestId: z.literal(body.requestId),
          decision: z.literal(body.decision),
          refreshRequired: z.literal(true),
          receipt: z.object({
            outcome: z.enum(['APPROVED', 'REVOKED', 'ALREADY_REVOKED']),
            grant_id: z.uuid().nullable(),
            grant_revision: z.number().int().positive().nullable(),
          }),
        })
        .safeParse(payload)
      if (!parsed.success) throw uncertain()
      return parsed.data
    },
  }
}
