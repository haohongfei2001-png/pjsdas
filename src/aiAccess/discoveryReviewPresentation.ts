import { presentDiscoveryQualityReason } from '../discoveryQualityReason.js'
import type { McpDiscoveryReviewItem } from '../ai/mcpProposal.js'

export function presentDiscoveryReviewReason(item: McpDiscoveryReviewItem, zh: boolean) {
  if (item.reasonDetail) return presentDiscoveryQualityReason(item.reasonDetail, zh)
  return item.reason ?? ''
}

export function presentDiscoveryReviewReasons(item: McpDiscoveryReviewItem, zh: boolean) {
  if (item.reasonDetails?.length) {
    return item.reasonDetails.map((detail) => presentDiscoveryQualityReason(detail, zh))
  }
  return item.reasons ?? []
}
