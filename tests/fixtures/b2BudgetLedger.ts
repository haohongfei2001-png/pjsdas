import { LedgerHarness, clone, type RpcBody } from './b2Ledger.rebuilt.js'
import type { DiscoverySpendPolicy } from '../../gateway/discoverySpendPolicy.js'

// This fixture models the SQL receipt wire format only. The separate PGlite and
// hosted PostgreSQL gates validate its transaction/lock/monetary-cap semantics.
export function budgetWire(db: LedgerHarness): typeof fetch {
  const processed = new Set<string>()
  return async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as RpcBody : undefined
    let response: Response | undefined
    try { response = await db.fetch(url, init) }
    finally {
      for (const row of [...db.rows.values()].sort((a, b) => a.resulting_revision - b.resulting_revision)) {
        if (processed.has(row.command_id)) continue
        processed.add(row.command_id)
        const hold = row.provenance.discoveryBudgetHold as { policy: DiscoverySpendPolicy; reservedMicroUsd: number } | undefined
        if (hold) {
          const spent = [...db.rows.values()].reduce((sum, old) => {
            const original = old.receipt.discoveryBudget as { hold?: typeof hold; retainedMicroUsd: number } | undefined
            return sum + (old.operation === 'checkpoint_discovery_search' && old.provenance.searchPhase === 'claimed'
              && original?.hold?.policy.approvalId === hold.policy.approvalId ? original.retainedMicroUsd : 0)
          }, 0)
          const admitted = spent + hold.reservedMicroUsd <= hold.policy.maximumMicroUsd
          row.receipt.discoveryBudget = { version: 1, hold: clone(hold), admitted, retainedMicroUsd: admitted ? hold.reservedMicroUsd : 0 }
        } else if (row.provenance.searchPhase === 'settled') {
          const original = [...db.rows.values()].find(candidate => candidate.provenance.searchPhase === 'claimed'
            && candidate.provenance.sourceId === row.provenance.sourceId
            && candidate.provenance.searchPlanFingerprint === row.provenance.searchPlanFingerprint
            && candidate.provenance.searchCycleId === row.provenance.searchCycleId
            && candidate.provenance.searchBatchIndex === row.provenance.searchBatchIndex)
          if (original?.receipt.discoveryBudget) row.receipt.discoveryBudget = clone(original.receipt.discoveryBudget)
        }
      }
    }
    if (body && response.ok) {
      const rows = await response.json() as Array<Record<string, unknown>>
      const original = db.rows.get(body.target_command_id)
      if (original && rows[0]?.outcome !== 'CONFLICT') rows[0].receipt = clone(original.receipt)
      return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } })
    }
    return response
  }
}
