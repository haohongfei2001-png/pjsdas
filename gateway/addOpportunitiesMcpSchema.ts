import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { addOpportunitiesSchema, addOpportunityCandidateSchema, type AddOpportunitiesArgs } from './addOpportunities.js'

// Some installed MCP catalogs still require this retired classification field.
// Accept only its former enum at the transport boundary, then discard it before
// any domain validation, identity/hash calculation, receipt, or workspace access.
// This is not a classification API: scores and every other unknown key remain
// invalid, and new clients are still advertised the strict facts-only contract.
const legacyCandidate = addOpportunityCandidateSchema.safeExtend({
  roleType: z.enum(['core', 'backup', 'reach', 'lottery', 'practice']).optional(),
}).transform(({ roleType: _discarded, ...facts }) => facts)
const inboundSchema = addOpportunitiesSchema.extend({
  opportunities: z.array(legacyCandidate).min(1).max(12),
}).pipe(addOpportunitiesSchema)

export const addOpportunitiesMcpSchema: StandardSchemaWithJSON<unknown, AddOpportunitiesArgs> = {
  '~standard': {
    ...addOpportunitiesSchema['~standard'],
    vendor: 'todayaction-legacy-add-boundary',
    validate: inboundSchema['~standard'].validate,
  },
}
