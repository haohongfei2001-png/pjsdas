/** Reviewed public recruiting-source bindings. Candidate/model output cannot
 * add entries. An ATS hostname alone never establishes an employer identity. */
import type { DiscoveryAuthorityEvidence } from '../src/discoveryFactSchema.js'

export interface DiscoverySourceAuthority {
  id: string
  kind: 'employer' | 'ats' | 'recruiting_platform' | 'university_recruiting'
  companyNames?: readonly string[]
  sourceOrigin: string
  pathPrefix: string
  /** Independently established employer/institution origin. */
  authorityOrigin: string
  /** Public page on that trusted origin linking to this exact recruiting site. */
  authorityPage: string
  adapter: 'job_posting_jsonld' | 'greenhouse'
  tenant?: string
  /** Only when the reviewed source explicitly equates this field with application cutoff. */
  applicationDeadlineField?: 'validThrough' | 'applicationDeadline'
  evidence?: DiscoveryAuthorityEvidence
  nativePostId?: string
  /** Source-native record value expected in the fetched document. Kept apart
   * from composite tenant/site identity; the request itself proves neither. */
  documentPostId?: string
}

/** Test/extension seam only. Production derives the supported institutional
 * relationship from current official publisher evidence, not a company list.
 * Historical model-supplied URLs never populate this registry. */
export const DISCOVERY_SOURCE_AUTHORITIES: readonly DiscoverySourceAuthority[] = []
