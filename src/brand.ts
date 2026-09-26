export const BRAND_NAME = 'TodayAction'
export const BRAND_ASSET_VERSION = 'ta-a-1'

export function brandAssetUrl(file: string) {
  return `${import.meta.env.BASE_URL}brand/${file}?v=${BRAND_ASSET_VERSION}`
}

export function brandDocumentTitle(surface: string, language: 'zh' | 'en') {
  const labels: Record<string, [string, string]> = {
    today: ['今天', 'Today'], opportunities: ['岗位库', 'Jobs'],
    schedule: ['日程', 'Schedule'], settings: ['设置', 'Settings'],
    decisions: ['待确认', 'Decisions'], history: ['历史', 'History'],
    capture: ['记录进展', 'Record an update'], authorization: ['ChatGPT 授权', 'ChatGPT authorization'],
  }
  const label = labels[surface]?.[language === 'zh' ? 0 : 1]
  return label ? `${label} · ${BRAND_NAME}` : BRAND_NAME
}
