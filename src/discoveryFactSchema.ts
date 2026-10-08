import { z } from 'zod/v4'

/** Claims from search/model output. Authority, discovery time, verification and
 * durable identity belong to the trusted adapter and are never input fields. */
export function factualDatePrecision(value: string): 'date' | 'datetime' | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? 'date' : undefined
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined
  const clock = value.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/)!
  if (factualDatePrecision(value.slice(0, 10)) !== 'date' || Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] ?? 0) > 59) return undefined
  return Number.isFinite(Date.parse(value)) ? 'datetime' : undefined
}

const factualDate = z.string().trim().max(80).refine(value => Boolean(factualDatePrecision(value)),
  'Use a real calendar date or a timestamp with an explicit offset; unknown time stays omitted.')
const precision = z.enum(['date', 'datetime'])

export const discoveryFactClaimShape = {
  company: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(240),
  sourceUrl: z.string().trim().url().max(2000).refine(value => /^https?:\/\//i.test(value), 'Discovery candidates require a public HTTP(S) recruiting source.'),
  sourceTitle: z.string().trim().min(1).max(300),
  sourceEvidenceText: z.string().trim().min(1).max(2000).optional(),
  location: z.string().trim().min(1).max(240).optional(),
  recruitmentBatch: z.string().trim().min(1).max(160).optional(),
  deadline: factualDate.optional(),
  deadlinePrecision: precision.optional(),
  publishedAt: factualDate.optional(),
  publishedPrecision: precision.optional(),
  postingStatus: z.enum(['open', 'closed', 'unknown']).optional(),
}

export function validateFactPrecision(value: { deadline?: string; deadlinePrecision?: string; publishedAt?: string; publishedPrecision?: string }, context: z.RefinementCtx) {
  for (const [field, precisionField] of [['deadline', 'deadlinePrecision'], ['publishedAt', 'publishedPrecision']] as const) {
    if (value[precisionField] && (!value[field] || factualDatePrecision(value[field]!) !== value[precisionField])) {
      context.addIssue({ code: 'custom', path: [precisionField], message: `${precisionField} must match its supplied value.` })
    }
  }
}

export const discoveryFactClaimSchema = z.object(discoveryFactClaimShape).strict().superRefine(validateFactPrecision)
export const discoveryObservationClaimSchema = z.object({
  sourceRecordId: z.string().trim().min(1).max(500),
  ...discoveryFactClaimShape,
}).strict().superRefine(validateFactPrecision)
export type DiscoveryFactClaim = z.infer<typeof discoveryFactClaimSchema>

/** Small proof references, never raw page bodies or model judgments. */
export interface DiscoveryFieldProof {
  field: 'company' | 'role' | 'location' | 'recruitmentBatch' | 'deadline' | 'publishedAt' | 'postingStatus'
  value: string
  sourceUrl: string
  selector: string
  quote: string
  documentSha256?: string
  verifiedAt?: string
}

export interface DiscoverySourceProof {
  version: 1
  authority: 'employer' | 'ats' | 'recruiting_platform' | 'university_recruiting'
  authorityUrl: string
  requestedUrl: string
  finalUrl: string
  verifiedAt: string
  documentSha256: string
  /** Bound to one attributed posting, never company/title similarity alone. */
  postingIdentity: string
  sourceNativeId?: string
  fields: DiscoveryFieldProof[]
  unresolvedFields?: Array<'deadline' | 'recruitmentBatch'>
  authorityEvidence?: DiscoveryAuthorityEvidence
}

export interface DiscoveryAuthorityEvidence {
  version: 1
  publisherId: 'cn-moe-affiliated-universities'
  institution: string
  rootUrl: string
  fetchedAt: string
  expiresAt: string
  links: Array<{ sourceUrl: string; href: string; targetUrl: string; selector: string; quote: string; documentSha256: string }>
}
