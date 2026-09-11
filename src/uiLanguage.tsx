import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type UiLanguage = 'zh' | 'en'

const STORAGE_KEY = 'pjsdas-ui-language'

const dictionary = {
  'nav.today': ['今日', 'Today'],
  'nav.discovery': ['发现箱', 'Discovery Inbox'],
  'nav.opportunities': ['机会', 'Opportunities'],
  'nav.pipeline': ['流程', 'Pipeline'],
  'nav.prep': ['准备', 'Prep'],
  'nav.timeline': ['历程', 'Timeline'],
  'nav.rules': ['规则', 'Rules'],
  'nav.settings': ['导入与设置', 'Import & Settings'],
  'brand.subtitle': ['求职决策与行动', 'Decision & Action'],
  'language.label': ['界面语言', 'Interface language'],
  'sidebar.lastImport': ['最近导入', 'Last import'],
  'common.loading': ['正在读取本地数据…', 'Loading local data…'],
  'common.done': ['完成', 'Done'],
  'common.items': ['项', 'items'],
  'common.localEvent': ['本地事件', 'Local event'],

  'today.title': ['今天先做什么', 'What should I do first?'],
  'today.subtitle': ['先保护真正会失效的节点，再按今天可投入时间生成行动计划。', 'Protect expiring windows first, then build an executable plan around the time you have today.'],
  'today.first': ['第一要做', 'Do first'],
  'today.currentFirst': ['当前计划的第一项', 'First item in the current plan'],
  'today.upcoming': ['近期节点', 'Upcoming'],
  'today.upcomingText': ['未来 7 天的重要节点，即使今天不做也会持续可见。', 'Important deadlines and fixed events in the next 7 days remain visible even when they are not in today’s plan.'],
  'today.nodeCount': ['个节点', 'nodes'],
  'today.fixed': ['固定安排', 'Fixed event'],
  'today.deadline': ['截止节点', 'Deadline'],
  'today.inPlan': ['已纳入今日计划', 'In today’s plan'],
  'today.ahead': ['提前有预期', 'Keep in view'],
  'today.available': ['今天还能投入多少时间？', 'How much time can you spend today?'],
  'today.plan': ['计划', 'Planned'],
  'today.actionPlan': ['行动计划', 'Action plan'],
  'today.hour1': ['1 小时', '1 hour'],
  'today.hour3': ['3 小时', '3 hours'],
  'today.hour6': ['6 小时', '6 hours'],
  'today.empty': ['当前时间预算下没有可执行行动', 'No executable action fits the current time budget'],

  'opportunities.title': ['机会池', 'Opportunities'],
  'opportunities.subtitle': ['默认只看仍需决策的当前机会；已投、过期和结束岗位自动分流。', 'The default view keeps only opportunities that still require a decision; applied, expired and closed roles are separated automatically.'],
  'opportunities.search': ['搜索公司或岗位', 'Search company or role'],
  'opportunities.active': ['当前机会', 'Active'],
  'opportunities.pipeline': ['已投 / 在途', 'Applied / pipeline'],
  'opportunities.expired': ['已过期', 'Expired'],
  'opportunities.closed': ['已结束', 'Closed'],
  'opportunities.allRecords': ['全部记录', 'All records'],
  'opportunities.allRoles': ['全部角色', 'All roles'],
  'opportunities.allTiming': ['全部时点', 'All timing'],
  'opportunities.company': ['公司', 'Company'],
  'opportunities.role': ['岗位', 'Role'],
  'opportunities.roleType': ['角色', 'Type'],
  'opportunities.priority': ['动态P级', 'Priority'],
  'opportunities.success': ['成功率', 'Success'],
  'opportunities.deadline': ['截止/节点', 'Deadline / node'],
  'opportunities.prep': ['准备', 'Prep'],
  'opportunities.group': ['申请组', 'Group'],

  'pipeline.title': ['在途流程', 'Pipeline'],
  'pipeline.subtitle': ['真实流程事件覆盖旧状态；复核风险按当前时间动态重算。', 'Real process events override stale state; review risk is recalculated against the current time.'],
  'pipeline.stage': ['阶段', 'Stage'],
  'pipeline.lastProgress': ['最后进展', 'Last progress'],
  'pipeline.threshold': ['复核阈值', 'Review threshold'],
  'pipeline.nextReview': ['下次复核', 'Next review'],
  'pipeline.review': ['需复核', 'Review'],
  'pipeline.waiting': ['正常等待', 'Waiting'],

  'prep.title': ['准备中心', 'Prep'],
  'prep.subtitle': ['只保留能跨岗位复用、并被真实机会或流程触发的准备。', 'Keep reusable preparation that is triggered by real opportunities or active processes.'],

  'settings.title': ['导入与设置', 'Import & Settings'],
  'settings.subtitle': ['本地 IndexedDB 始终可独立工作；账号与云端同步用于跨设备恢复和未来 AI 接入。Excel 继续只承担初始导入与恢复。', 'Local IndexedDB always works independently; account and cloud sync support cross-device recovery and future AI access. Excel remains an initialization and recovery path.'],
  'settings.languageTitle': ['界面语言', 'Interface language'],
  'settings.languageText': ['切换一级目录、页面标题与主要操作。岗位和公司等原始数据保持原文。', 'Switch primary navigation, page headings and major controls. Company and role data remain unchanged.'],
  'settings.chooseFile': ['选择文件', 'Choose file'],
  'settings.processing': ['处理中…', 'Processing…'],
  'settings.confirmImport': ['确认导入', 'Confirm import'],
} as const

type TranslationKey = keyof typeof dictionary

type UiLanguageContextValue = {
  lang: UiLanguage
  setLang: (lang: UiLanguage) => void
  t: (key: TranslationKey) => string
}

const UiLanguageContext = createContext<UiLanguageContextValue | null>(null)

function initialLanguage(): UiLanguage {
  if (typeof window === 'undefined') return 'zh'
  return window.localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh'
}

function applyLanguage(lang: UiLanguage) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, lang)
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  document.documentElement.dataset.uiLang = lang
}

export function UiLanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLanguage] = useState<UiLanguage>(initialLanguage)

  useEffect(() => {
    applyLanguage(lang)
  }, [lang])

  const value = useMemo<UiLanguageContextValue>(() => ({
    lang,
    setLang: (next) => {
      applyLanguage(next)
      setLanguage(next)
    },
    t: (key) => dictionary[key][lang === 'zh' ? 0 : 1],
  }), [lang])

  return <UiLanguageContext.Provider value={value}>{children}</UiLanguageContext.Provider>
}

export function useUiLanguage() {
  const context = useContext(UiLanguageContext)
  if (!context) throw new Error('useUiLanguage must be used inside UiLanguageProvider')
  return context
}

export function currentUiLanguage(): UiLanguage {
  if (typeof window === 'undefined') return 'zh'
  return window.localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh'
}
