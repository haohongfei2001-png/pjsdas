import type { PJSDASSnapshot } from './snapshot.js'
import type { McpProposalEnvelope } from './ai/mcpProposal.js'
import { ScoringRetiredError } from './scoringRetirement.js'

// Existing signatures and historical payload decoding remain compatible; this can never write rules.
export function applyMcpRulesCommand(_snapshot: PJSDASSnapshot, _proposal: McpProposalEnvelope, _now = new Date()): never {
  throw new ScoringRetiredError()
}
