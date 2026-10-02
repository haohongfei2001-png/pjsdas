import type { ReserveDiscoverySpend } from '../../gateway/discoveryBudgetGuard.js'
// Isolated fixture only. Production has no reservation adapter until a separate
// TodayAction budget and durable accounting implementation have been approved.
export const syntheticReserveDiscoverySpend: ReserveDiscoverySpend = async request => ({ ...request, reservationId: `fixture:${request.requestId}`, reservedUsd: 1, expiresAt: '2099-01-01T00:00:00Z' })
export const syntheticDiscoveryBudget = { reserveSpend: syntheticReserveDiscoverySpend, budgetAccountId: '00000000-0000-4000-8000-000000000001', budgetSourceId: 'monitor:urgent-campus' }
