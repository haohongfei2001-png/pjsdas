import * as z from 'zod/v4'

export const scopedConsentDomainSchema = z.enum(['opportunity', 'planning', 'discoveryProfile', 'privateReminder'])
export const scopedConsentChoiceSchema = z.object({
  domain: scopedConsentDomainSchema,
  decision: z.enum(['approve', 'revoke']),
  consentVersion: z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  consentTextHash: z.string().regex(/^[0-9a-f]{64}$/),
  expectedGrant: z.object({ id: z.uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().nullable(),
}).strict().refine(choice => choice.decision !== 'revoke' || choice.expectedGrant !== null)
export const scopedConsentDecisionSchema = z.object({
  requestId: z.uuid(), expectedAccountId: z.uuid(), clientId: z.uuid(),
  choices: z.array(scopedConsentChoiceSchema).min(1).max(4), confirmed: z.literal(true),
}).strict().refine(value => new Set(value.choices.map(choice => choice.domain)).size === value.choices.length)
export type ScopedConsentDecision = z.infer<typeof scopedConsentDecisionSchema>
