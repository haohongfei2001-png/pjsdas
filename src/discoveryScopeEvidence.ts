import { z } from 'zod/v4'
import type { DiscoveryProfile } from './discoveryProfile.js'

const rules = z.array(z.string().min(1).max(160)).max(30)
const matches = z.array(z.number().int().min(0).max(29)).max(30)
/** Trusted verifier output only. Public model/MCP claim schemas never accept it.
 * Rule lists permit exact, synchronous current-scope comparison in the reducer;
 * hashes bind the full profile and fetched document at the gateway/CAS boundary.
 * This bounded evidence is not copied into the saved Opportunity. */
export const discoveryScopeEvidenceSchema = z.object({
  version: z.literal(1),
  scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: z.enum(['complete', 'incomplete']),
  mustHave: rules,
  mustNotHave: rules,
  matchedRequired: matches,
  matchedExcluded: matches,
}).strict().superRefine((value, ctx) => {
  for (const [key, list] of [['matchedRequired', value.mustHave], ['matchedExcluded', value.mustNotHave]] as const) {
    const indices = value[key]
    if (new Set(indices).size !== indices.length || indices.some(index => index >= list.length)) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'Scope matches must identify unique current rules.' })
    }
  }
})
export type DiscoveryScopeEvidence = z.infer<typeof discoveryScopeEvidenceSchema>

export function compactDiscoveryScopeText(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}
export function discoveryScopeLiteralPresent(rule: string, evidence: string) {
  const token = compactDiscoveryScopeText(rule)
  return token.length >= 2 && evidence.includes(token)
}

export function buildDiscoveryScopeEvidence(input: {
  profile: Pick<DiscoveryProfile, 'mustHave' | 'mustNotHave'>
  scopeFingerprint: string
  documentSha256: string
  text: string
  complete: boolean
}): DiscoveryScopeEvidence {
  const evidence = compactDiscoveryScopeText(input.text)
  const matched = (rules: string[]) => rules.flatMap((rule, index) => discoveryScopeLiteralPresent(rule, evidence) ? [index] : [])
  return discoveryScopeEvidenceSchema.parse({ version: 1, scopeFingerprint: input.scopeFingerprint,
    documentSha256: input.documentSha256, coverage: input.complete ? 'complete' : 'incomplete',
    mustHave: [...input.profile.mustHave], mustNotHave: [...input.profile.mustNotHave],
    matchedRequired: matched(input.profile.mustHave), matchedExcluded: matched(input.profile.mustNotHave) })
}

export function currentDiscoveryScopeEvidence(profile: Pick<DiscoveryProfile, 'mustHave' | 'mustNotHave'>,
  evidence: DiscoveryScopeEvidence | undefined, documentSha256: string | undefined) {
  return evidence?.coverage === 'complete' && evidence.documentSha256 === documentSha256
    && JSON.stringify(evidence.mustHave) === JSON.stringify(profile.mustHave)
    && JSON.stringify(evidence.mustNotHave) === JSON.stringify(profile.mustNotHave)
    ? evidence : undefined
}
