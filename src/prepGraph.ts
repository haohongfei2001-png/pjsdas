import type { Action, Opportunity, Prep, ProcessRecord, ProcessStage } from './model.js'

export type PrepLinkSource = 'explicit_trigger' | 'process_pack' | 'structured_requirement' | 'structured_gap' | 'legacy_gap' | 'process_stage'
export type PrepLinkConfidence = 'high' | 'medium'
export type PrepNeedKind = 'requirement' | 'gap' | 'process'

export interface PrepOpportunityNeed {
  id: string
  opportunityId: string
  company: string
  role: string
  kind: PrepNeedKind
  label: string
  severity: number
  source: string
}

export interface PrepGraphLink {
  prepId: string
  opportunityId: string
  source: PrepLinkSource
  confidence: PrepLinkConfidence
  matchedNeedIds: string[]
  explanation: string
}

export interface PrepGraphNode {
  prepId: string
  title: string
  sourceStatus?: string
  estimatedMinutes: number
  links: PrepGraphLink[]
  coveredOpportunityIds: string[]
  coverageCount: number
  matchedNeedCount: number
  leverageScore: number
  urgencyScore: number
  valueScore: number
  coverageScore: number
  needScore: number
  nextRelevantAt?: string
  triggerSuggested: boolean
}

export interface PrepGraph {
  generatedAt: string
  nodes: PrepGraphNode[]
  links: PrepGraphLink[]
  needs: PrepOpportunityNeed[]
  uncoveredNeeds: PrepOpportunityNeed[]
}

const ACTIVE_PREP_STAGES = new Set<ProcessStage>(['not_applied', 'screening', 'assessment', 'written_test', 'interview'])
const GENERIC_MATCH_TERMS = new Set(['能力', '准备', '岗位', '产品', '分析', '经验', '要求', '工作', '项目'])

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value))
}

function compact(value: string | undefined) {
  return (value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_\-+]+/g, '')
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function splitList(value: string | undefined) {
  return unique((value ?? '').split(/[\n,，;；、|/]+/).map((item) => item.trim()).filter(Boolean))
}

function meaningfulMatchTerm(value: string) {
  const normalized = compact(value)
  if (!normalized || GENERIC_MATCH_TERMS.has(normalized)) return false
  const asciiOnly = /^[a-z0-9.+#]+$/i.test(normalized)
  return normalized.length >= (asciiOnly ? 3 : 2)
}

function textContainsTerm(text: string, term: string) {
  const haystack = compact(text)
  const needle = compact(term)
  // Deterministic matching is intentionally one-way: a specific requirement
  // such as “产品分析” may match “产品分析专项准备”, but a generic Prep title
  // such as “分析” must not match the more specific requirement by reverse
  // substring containment.
  return meaningfulMatchTerm(term) && Boolean(haystack && needle && haystack.includes(needle))
}

function futureIso(values: Array<string | undefined>, now: Date) {
  return values
    .filter((value): value is string => Boolean(value) && !Number.isNaN(new Date(value!).getTime()))
    .filter((value) => new Date(value).getTime() >= now.getTime())
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0]
}

function deadlineUrgency(value: string | undefined, now: Date) {
  if (!value) return undefined
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return undefined
  const hours = (time - now.getTime()) / 3_600_000
  if (hours < 0) return 0
  if (hours <= 24) return 100
  if (hours <= 72) return 90
  if (hours <= 168) return 75
  if (hours <= 336) return 55
  return 35
}

function stageUrgency(stage: ProcessStage) {
  const scores: Record<ProcessStage, number> = {
    not_applied: 38,
    screening: 52,
    assessment: 78,
    written_test: 86,
    interview: 94,
    offer: 0,
    waiting_release: 0,
    closed: 0,
  }
  return scores[stage]
}

function processNeed(stage: ProcessStage) {
  if (stage === 'assessment') return { label: '测评准备', severity: 82 }
  if (stage === 'written_test') return { label: '笔试准备', severity: 90 }
  if (stage === 'interview') return { label: '面试准备', severity: 96 }
  return undefined
}

function needId(opportunityId: string, kind: PrepNeedKind, label: string) {
  return `${opportunityId}:${kind}:${compact(label)}`
}

function addNeed(target: Map<string, PrepOpportunityNeed>, need: PrepOpportunityNeed) {
  const existing = target.get(need.id)
  if (!existing || need.severity > existing.severity) target.set(need.id, need)
}

function assessmentScore(opportunity: Opportunity, key: 'skills' | 'language' | 'experience' | 'industry') {
  return opportunity.detail?.assessment?.fit[key]?.score
}

function buildOpportunityNeeds(opportunity: Opportunity): PrepOpportunityNeed[] {
  const needs = new Map<string, PrepOpportunityNeed>()
  const facts = opportunity.detail?.facts
  const base = { opportunityId: opportunity.id, company: opportunity.company, role: opportunity.role }

  for (const skill of facts?.role.skills ?? []) {
    addNeed(needs, {
      ...base,
      id: needId(opportunity.id, 'requirement', skill),
      kind: 'requirement',
      label: skill,
      severity: 52,
      source: 'Rich Opportunity · skill requirement',
    })
  }
  for (const language of facts?.role.languageRequirements ?? []) {
    addNeed(needs, {
      ...base,
      id: needId(opportunity.id, 'requirement', language),
      kind: 'requirement',
      label: language,
      severity: 48,
      source: 'Rich Opportunity · language requirement',
    })
  }

  const skillScore = assessmentScore(opportunity, 'skills')
  if (skillScore !== undefined && skillScore < 75) {
    const labels = facts?.role.skills?.length ? facts.role.skills : ['技能匹配']
    for (const label of labels) {
      addNeed(needs, {
        ...base,
        id: needId(opportunity.id, 'gap', label),
        kind: 'gap',
        label,
        severity: clamp(100 - skillScore + 35),
        source: `Fit assessment · skills ${skillScore}`,
      })
    }
  }

  const languageScore = assessmentScore(opportunity, 'language')
  if (languageScore !== undefined && languageScore < 75) {
    const labels = facts?.role.languageRequirements?.length ? facts.role.languageRequirements : ['语言能力']
    for (const label of labels) {
      addNeed(needs, {
        ...base,
        id: needId(opportunity.id, 'gap', label),
        kind: 'gap',
        label,
        severity: clamp(100 - languageScore + 35),
        source: `Fit assessment · language ${languageScore}`,
      })
    }
  }

  const experienceScore = assessmentScore(opportunity, 'experience')
  if (experienceScore !== undefined && experienceScore < 70 && facts?.role.experienceRequirement) {
    addNeed(needs, {
      ...base,
      id: needId(opportunity.id, 'gap', facts.role.experienceRequirement),
      kind: 'gap',
      label: facts.role.experienceRequirement,
      severity: clamp(100 - experienceScore + 30),
      source: `Fit assessment · experience ${experienceScore}`,
    })
  }

  const industryScore = assessmentScore(opportunity, 'industry')
  if (industryScore !== undefined && industryScore < 65) {
    addNeed(needs, {
      ...base,
      id: needId(opportunity.id, 'gap', '行业知识'),
      kind: 'gap',
      label: '行业知识',
      severity: clamp(100 - industryScore + 25),
      source: `Fit assessment · industry ${industryScore}`,
    })
  }

  for (const gap of splitList(opportunity.detail?.gap)) {
    addNeed(needs, {
      ...base,
      id: needId(opportunity.id, 'gap', gap),
      kind: 'gap',
      label: gap,
      severity: 82,
      source: 'Opportunity detail · explicit gap',
    })
  }

  const stage = processNeed(opportunity.processStage)
  if (stage) {
    addNeed(needs, {
      ...base,
      id: needId(opportunity.id, 'process', stage.label),
      kind: 'process',
      label: stage.label,
      severity: stage.severity,
      source: `Process stage · ${opportunity.processStage}`,
    })
  }

  return [...needs.values()]
}

function triggerTokens(prep: Prep) {
  return splitList(prep.triggeredBy)
}

function explicitTriggerMatches(prep: Prep, opportunity: Opportunity, allOpportunities: Opportunity[]) {
  const tokens = triggerTokens(prep)
  if (!tokens.length) return false
  const roleKey = compact(opportunity.role)
  const roleUnique = allOpportunities.filter((item) => compact(item.role) === roleKey).length === 1
  return tokens.some((token) => {
    const key = compact(token)
    if (!key) return false
    if (key === compact(opportunity.id)) return true
    if (opportunity.applicationGroupId && key === compact(opportunity.applicationGroupId)) return true
    if (key === compact(`${opportunity.company}${opportunity.role}`)) return true
    if (roleUnique && key === roleKey) return true
    return false
  })
}

function processPackMatches(prep: Prep, process: ProcessRecord) {
  if (!process.prepPack?.trim()) return false
  const pack = compact(process.prepPack)
  const title = compact(prep.title)
  return Boolean(pack && title && (pack.includes(title) || title.includes(pack)))
}

function prepHaystack(prep: Prep) {
  return [prep.title, prep.minimumOutput, prep.triggerRule].filter(Boolean).join(' · ')
}

function needMatchesPrep(prep: Prep, need: PrepOpportunityNeed) {
  const text = prepHaystack(prep)
  if (need.kind === 'process') {
    const keywords = need.label.includes('面试') ? ['面试', 'case', '自我介绍', '项目讲解']
      : need.label.includes('笔试') ? ['笔试', '行测', 'SQL', '算法', '测验']
        : ['测评', '行测', '性格测试']
    return keywords.some((keyword) => textContainsTerm(text, keyword))
  }
  return textContainsTerm(text, need.label)
}

function linkRank(source: PrepLinkSource) {
  if (source === 'explicit_trigger' || source === 'process_pack') return 3
  if (source === 'structured_gap' || source === 'legacy_gap' || source === 'process_stage') return 2
  return 1
}

function addLink(target: Map<string, PrepGraphLink>, link: PrepGraphLink) {
  const key = `${link.prepId}|${link.opportunityId}`
  const existing = target.get(key)
  if (!existing) {
    target.set(key, link)
    return
  }
  const matchedNeedIds = unique([...existing.matchedNeedIds, ...link.matchedNeedIds])
  if (linkRank(link.source) > linkRank(existing.source)) target.set(key, { ...link, matchedNeedIds })
  else target.set(key, { ...existing, matchedNeedIds })
}

function opportunityUrgency(opportunity: Opportunity, now: Date) {
  return Math.max(
    stageUrgency(opportunity.processStage),
    deadlineUrgency(opportunity.effectiveProcessEventAt, now) ?? 0,
    deadlineUrgency(opportunity.deadline, now) ?? 0,
  )
}

function topAverage(values: number[], limit = 3) {
  if (!values.length) return 0
  const picked = [...values].sort((a, b) => b - a).slice(0, limit)
  return picked.reduce((sum, value) => sum + value, 0) / picked.length
}

export function buildPrepGraph(
  prepItems: Prep[],
  opportunities: Opportunity[],
  processes: ProcessRecord[] = [],
  now = new Date(),
): PrepGraph {
  const activeOpportunities = opportunities.filter((item) => ACTIVE_PREP_STAGES.has(item.processStage))
  const opportunityMap = new Map(activeOpportunities.map((item) => [item.id, item]))
  const needs = activeOpportunities.flatMap(buildOpportunityNeeds)
  const needsByOpportunity = new Map<string, PrepOpportunityNeed[]>()
  for (const need of needs) {
    const list = needsByOpportunity.get(need.opportunityId) ?? []
    list.push(need)
    needsByOpportunity.set(need.opportunityId, list)
  }

  const links = new Map<string, PrepGraphLink>()
  for (const prep of prepItems) {
    for (const opportunity of activeOpportunities) {
      if (explicitTriggerMatches(prep, opportunity, activeOpportunities)) {
        addLink(links, {
          prepId: prep.id,
          opportunityId: opportunity.id,
          source: 'explicit_trigger',
          confidence: 'high',
          matchedNeedIds: [],
          explanation: 'Prep 的“触发岗位/申请组”显式指向该岗位。',
        })
      }
    }
    for (const process of processes) {
      if (!process.opportunityId || !opportunityMap.has(process.opportunityId) || !processPackMatches(prep, process)) continue
      addLink(links, {
        prepId: prep.id,
        opportunityId: process.opportunityId,
        source: 'process_pack',
        confidence: 'high',
        matchedNeedIds: [],
        explanation: '在途流程的“触发准备包”显式匹配该 Prep。',
      })
    }
    for (const need of needs) {
      if (!needMatchesPrep(prep, need)) continue
      const source: PrepLinkSource = need.kind === 'process'
        ? 'process_stage'
        : need.kind === 'gap'
          ? (need.source.startsWith('Opportunity detail') ? 'legacy_gap' : 'structured_gap')
          : 'structured_requirement'
      addLink(links, {
        prepId: prep.id,
        opportunityId: need.opportunityId,
        source,
        confidence: source === 'structured_requirement' ? 'medium' : 'high',
        matchedNeedIds: [need.id],
        explanation: need.kind === 'requirement'
          ? `Prep 文本与结构化要求“${need.label}”精确匹配。`
          : `Prep 文本与当前准备需求“${need.label}”精确匹配。`,
      })
    }
  }

  const linkList = [...links.values()]
  const matchedNeedIds = new Set(linkList.flatMap((link) => link.matchedNeedIds))
  const uncoveredNeeds = needs
    .filter((need) => need.kind !== 'requirement' && !matchedNeedIds.has(need.id))
    .sort((a, b) => b.severity - a.severity || a.company.localeCompare(b.company) || a.role.localeCompare(b.role))

  const nodes = prepItems.map((prep) => {
    const nodeLinks = linkList.filter((link) => link.prepId === prep.id)
    const coveredOpportunityIds = unique(nodeLinks.map((link) => link.opportunityId))
    const covered = coveredOpportunityIds.map((id) => opportunityMap.get(id)).filter((item): item is Opportunity => Boolean(item))
    const nodeMatchedNeeds = unique(nodeLinks.flatMap((link) => link.matchedNeedIds))
      .map((id) => needs.find((need) => need.id === id))
      .filter((item): item is PrepOpportunityNeed => Boolean(item))
    const coverageScore = covered.length ? clamp(30 + covered.length * 14) : 0
    const valueScore = Math.round(topAverage(covered.map((item) => item.opportunityValue)))
    const urgencyScore = Math.round(covered.length ? Math.max(...covered.map((item) => opportunityUrgency(item, now))) : 0)
    const needScore = Math.round(nodeMatchedNeeds.length ? topAverage(nodeMatchedNeeds.map((item) => item.severity), 4) : covered.length ? 45 : 0)
    const confidenceFactor = nodeLinks.some((link) => link.confidence === 'high') ? 1 : nodeLinks.length ? 0.9 : 1
    const leverageScore = Math.round(clamp((
      coverageScore * 0.35 +
      valueScore * 0.30 +
      urgencyScore * 0.20 +
      needScore * 0.15
    ) * confidenceFactor))
    const nextRelevantAt = futureIso(covered.flatMap((item) => [item.effectiveProcessEventAt, item.deadline]), now)
    const waiting = prep.sourceStatus === '等待触发' || prep.sourceStatus?.toLocaleLowerCase() === 'waiting'
    return {
      prepId: prep.id,
      title: prep.title,
      sourceStatus: prep.sourceStatus,
      estimatedMinutes: prep.estimatedMinutes,
      links: nodeLinks,
      coveredOpportunityIds,
      coverageCount: coveredOpportunityIds.length,
      matchedNeedCount: nodeMatchedNeeds.filter((need) => need.kind !== 'requirement').length,
      leverageScore,
      urgencyScore,
      valueScore,
      coverageScore,
      needScore,
      nextRelevantAt,
      triggerSuggested: Boolean(waiting && coveredOpportunityIds.length && leverageScore >= 55),
    } satisfies PrepGraphNode
  }).sort((a, b) => b.leverageScore - a.leverageScore || b.coverageCount - a.coverageCount || a.title.localeCompare(b.title))

  return {
    generatedAt: now.toISOString(),
    nodes,
    links: linkList,
    needs,
    uncoveredNeeds,
  }
}

export function enrichPrepActionsWithGraph(actions: Action[], graph: PrepGraph): Action[] {
  const nodeByPrep = new Map(graph.nodes.map((node) => [node.prepId, node]))
  return actions.map((action) => {
    if (action.kind !== 'prep' || !action.prepId) return action
    const node = nodeByPrep.get(action.prepId)
    if (!node || node.coverageCount === 0) return action
    const graphDelayCost = Math.round(clamp(node.urgencyScore * 0.72 + node.needScore * 0.28))
    const graphLabel = `Prep Graph · 覆盖${node.coverageCount}岗${node.matchedNeedCount ? ` · ${node.matchedNeedCount}个需求` : ''}`
    return {
      ...action,
      dueAt: action.dueAt ?? node.nextRelevantAt,
      leverage: Math.max(action.leverage, node.leverageScore),
      delayCost: Math.max(action.delayCost, graphDelayCost),
      sourceLabel: graphLabel,
    }
  })
}

export function prepGraphReasonFromAction(action: Action) {
  if (action.kind !== 'prep' || !action.sourceLabel?.startsWith('Prep Graph · ')) return undefined
  return action.sourceLabel.replace('Prep Graph · ', '')
}
