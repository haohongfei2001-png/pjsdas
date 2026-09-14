import type { Opportunity } from './model.js'

export type UiStageLanguage = 'zh' | 'en'

const STAGE_LABELS: Record<Opportunity['processStage'], { zh: string; en: string }> = {
  not_applied: { zh: '待投递', en: 'Not applied' },
  screening: { zh: '筛选中', en: 'Screening' },
  assessment: { zh: '测评', en: 'Assessment' },
  written_test: { zh: '笔试', en: 'Written test' },
  interview: { zh: '面试', en: 'Interview' },
  offer: { zh: 'Offer', en: 'Offer' },
  waiting_release: { zh: '等待开放', en: 'Waiting release' },
  closed: { zh: '已结束', en: 'Closed' },
}

const CANONICAL_STORED_LABELS = new Set([
  '待投', '待投递', '筛选中', '测评', '笔试', '面试', 'offer', '等待开放', '流程结束', '已结束',
  'not applied', 'screening', 'assessment', 'written test', 'interview', 'waiting release', 'closed',
])

export function presentStageLabel(
  stage: Opportunity['processStage'],
  storedLabel: string | undefined,
  lang: UiStageLanguage,
) {
  const fallback = STAGE_LABELS[stage][lang]
  const stored = storedLabel?.trim()
  if (!stored) return fallback
  if (lang === 'zh') return stored
  if (CANONICAL_STORED_LABELS.has(stored.toLocaleLowerCase())) return fallback
  return stored
}

export function canonicalStageLabel(stage: Opportunity['processStage'], lang: UiStageLanguage) {
  return STAGE_LABELS[stage][lang]
}
