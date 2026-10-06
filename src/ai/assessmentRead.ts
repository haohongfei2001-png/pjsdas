import type { PJSDASSnapshot } from '../snapshot.js'
import { BridgeReadError } from './readLayer.js'

export interface GetOpportunityAssessmentInput { opportunityId: string }

/** Historic assessment fields remain in snapshots; this retired API never projects them. */
export function getOpportunityAssessment(_snapshot: PJSDASSnapshot, _input: GetOpportunityAssessmentInput): never {
  throw new BridgeReadError('SCORING_RETIRED', 'Opportunity fit/value scoring has been retired. Use get_opportunity_detail for source facts and actual deadlines.')
}
