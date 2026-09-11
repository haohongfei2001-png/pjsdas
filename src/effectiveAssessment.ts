import { dbPromise, getAllOpportunities, getDecisionRules } from './db.js'
import { decisionRulesForSnapshot } from './decisionRules.js'
import {
  projectDiscoveryInboxAssessment,
  projectOpportunityAssessment,
} from './opportunityAssessment.js'

export async function getAllAssessedOpportunities() {
  const [opportunities, rawRules] = await Promise.all([
    getAllOpportunities(),
    getDecisionRules(),
  ])
  const rules = decisionRulesForSnapshot(rawRules)
  return opportunities.map((item) => projectOpportunityAssessment(item, rules))
}

export async function getAllAssessedDiscoveryInboxItems() {
  const db = await dbPromise
  const [items, rawRules] = await Promise.all([
    db.getAll('discoveryInbox'),
    getDecisionRules(),
  ])
  const rules = decisionRulesForSnapshot(rawRules)
  return items
    .map((item) => projectDiscoveryInboxAssessment(item, rules))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.company.localeCompare(b.company))
}
