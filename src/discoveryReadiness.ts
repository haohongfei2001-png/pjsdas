export interface DiscoveryReadiness {
  profileConfigured: boolean | null
  budgetState: 'approval_required'
}
/** A switch and scheduler check do not establish an operational search. */
export function discoveryReadinessLabel(input: { verified: boolean; enabled?: boolean; readiness?: DiscoveryReadiness | null }, zh: boolean) {
  if (!input.verified || input.enabled === undefined) return zh ? '状态待核对' : 'Status unverified'
  if (!input.enabled) return zh ? '未启用' : 'Disabled'
  if (input.readiness?.profileConfigured === false) return zh ? '待配置发现偏好' : 'Discovery preferences required'
  if (input.readiness?.profileConfigured !== true) return zh ? '发现配置待核对' : 'Discovery configuration unverified'
  return zh ? '待批准 TA 搜索预算' : 'TodayAction search budget required'
}
