import { useEffect, useMemo, useState } from 'react'
import { applyDecisionRulesChangeSet } from './db.js'
import {
  cloneDecisionRules,
  DEFAULT_DECISION_RULES,
  validateDecisionRules,
  type DecisionRules,
  type DecisionWeights,
  type FitComponentWeights,
  type OpportunityValueComponentWeights,
} from './decisionRules.js'
import { useUiLanguage } from './uiLanguage.js'
import './rules.css'

type Props = {
  rules: DecisionRules
  onChanged: () => Promise<void>
}

type NumericRuleKey = Exclude<
  keyof DecisionRules,
  'key' | 'version' | 'weights' | 'fitComponentWeights' | 'opportunityValueComponentWeights' | 'updatedAt'
>

const weightKeys: Array<keyof DecisionWeights> = [
  'opportunity', 'fit', 'urgency', 'stage', 'leverage', 'delayCost', 'timeEfficiency',
]
const fitComponentWeightKeys: Array<keyof FitComponentWeights> = [
  'roleDirection', 'skills', 'education', 'experience', 'industry', 'language', 'location',
]
const opportunityComponentWeightKeys: Array<keyof OpportunityValueComponentWeights> = [
  'companyQuality', 'roleGrowth', 'compensation', 'careerOptionality', 'brandValue', 'industryGrowth', 'locationValue',
]

export default function RulesView({ rules, onChanged }: Props) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const normalizedRules = useMemo(() => cloneDecisionRules(rules), [rules])
  const [draft, setDraft] = useState(() => cloneDecisionRules(rules))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => setDraft(cloneDecisionRules(rules)), [rules])

  const errors = useMemo(() => validateDecisionRules(draft), [draft])
  const dirty = JSON.stringify({ ...draft, updatedAt: '' }) !== JSON.stringify({ ...normalizedRules, updatedAt: '' })

  const setNumber = (key: NumericRuleKey, value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    setDraft((current) => ({ ...current, [key]: parsed }))
    setMessage('')
  }

  const setWeight = (key: keyof DecisionWeights, value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    setDraft((current) => ({ ...current, weights: { ...current.weights, [key]: parsed } }))
    setMessage('')
  }

  const setFitComponentWeight = (key: keyof FitComponentWeights, value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    setDraft((current) => ({
      ...current,
      fitComponentWeights: { ...current.fitComponentWeights!, [key]: parsed },
    }))
    setMessage('')
  }

  const setOpportunityComponentWeight = (key: keyof OpportunityValueComponentWeights, value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    setDraft((current) => ({
      ...current,
      opportunityValueComponentWeights: { ...current.opportunityValueComponentWeights!, [key]: parsed },
    }))
    setMessage('')
  }

  async function save() {
    if (errors.length) return
    setBusy(true)
    try {
      const changeSet = await applyDecisionRulesChangeSet(draft, 'save')
      await onChanged()
      setMessage(changeSet
        ? (zh
            ? `ChangeSet ${changeSet.id} 已应用。新岗位评估会使用新的组件权重；已保存的历史岗位分数不会被静默改写。`
            : `ChangeSet ${changeSet.id} applied. New assessments use the new component weights; stored historical scores are not silently rewritten.`)
        : (zh ? '规则没有变化。' : 'No rule changes.'))
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    setBusy(true)
    try {
      const changeSet = await applyDecisionRulesChangeSet(DEFAULT_DECISION_RULES, 'reset')
      await onChanged()
      setMessage(changeSet
        ? (zh ? `ChangeSet ${changeSet.id} 已应用，已恢复 PJSDAS 推荐规则。` : `ChangeSet ${changeSet.id} applied. Recommended rules restored.`)
        : (zh ? '当前已经是推荐规则。' : 'Recommended rules are already active.'))
    } finally {
      setBusy(false)
    }
  }

  const weightLabels: Record<keyof DecisionWeights, [string, string]> = {
    opportunity: ['机会价值', 'Opportunity value'],
    fit: ['匹配度', 'Fit'],
    urgency: ['时间紧迫度', 'Urgency'],
    stage: ['流程阶段', 'Process stage'],
    leverage: ['行动杠杆', 'Leverage'],
    delayCost: ['拖延损失', 'Delay cost'],
    timeEfficiency: ['时间效率', 'Time efficiency'],
  }
  const fitComponentLabels: Record<keyof FitComponentWeights, [string, string]> = {
    roleDirection: ['岗位方向', 'Role direction'],
    skills: ['技能匹配', 'Skills'],
    education: ['学历匹配', 'Education'],
    experience: ['经验匹配', 'Experience'],
    industry: ['行业匹配', 'Industry'],
    language: ['语言匹配', 'Language'],
    location: ['地点匹配', 'Location'],
  }
  const opportunityComponentLabels: Record<keyof OpportunityValueComponentWeights, [string, string]> = {
    companyQuality: ['公司质量', 'Company quality'],
    roleGrowth: ['岗位成长', 'Role growth'],
    compensation: ['薪资价值', 'Compensation'],
    careerOptionality: ['职业选择权', 'Career optionality'],
    brandValue: ['品牌价值', 'Brand value'],
    industryGrowth: ['行业成长', 'Industry growth'],
    locationValue: ['地点价值', 'Location value'],
  }

  return (
    <section className="rules-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">DECISION RULES · V1.5</div>
          <h1>{zh ? '决策规则' : 'Decision Rules'}</h1>
          <p>{zh
            ? '这些规则驱动 Today 排序，也决定新岗位的匹配度与机会价值如何由分项评估聚合。组件权重是显式策略；修改它不会静默重写已经保存的历史岗位分数。'
            : 'These rules drive Today ranking and define how new opportunity assessments aggregate component scores into Fit and Opportunity Value. Component weights are explicit policy; editing them does not silently rewrite stored historical scores.'}</p>
        </div>
      </header>

      <div className="rules-summary-grid">
        <RuleSummary label={zh ? '硬截止保护' : 'Deadline protection'} value={`${draft.hardDeadlineHorizonHours}h`} />
        <RuleSummary label={zh ? '近期节点' : 'Upcoming horizon'} value={`${draft.upcomingHorizonDays}${zh ? '天' : 'd'}`} />
        <RuleSummary label={zh ? '匹配度分项' : 'Fit components'} value={`${fitComponentWeightKeys.length}`} />
        <RuleSummary label={zh ? '机会价值分项' : 'Value components'} value={`${opportunityComponentWeightKeys.length}`} />
      </div>

      <div className="rules-grid">
        <RuleCard eyebrow="DEADLINE RISK" title={zh ? '截止与风险' : 'Deadline & risk'} description={zh ? '控制什么时候开始保护任务，以及倒计时如何分级。' : 'Controls when tasks are protected and how countdown risk is classified.'}>
          <RuleField label={zh ? '硬截止保护窗口' : 'Hard-deadline protection'} value={draft.hardDeadlineHorizonHours} unit={zh ? '小时' : 'hours'} min={1} max={336} onChange={(v) => setNumber('hardDeadlineHorizonHours', v)} />
          <RuleField label={zh ? '固定事件预告窗口' : 'Fixed-event lookahead'} value={draft.fixedEventHorizonHours} unit={zh ? '小时' : 'hours'} min={1} max={336} onChange={(v) => setNumber('fixedEventHorizonHours', v)} />
          <div className="risk-thresholds">
            <RuleField label={zh ? '极高风险' : 'Critical'} value={draft.riskCriticalHours} unit="h" min={1} max={168} onChange={(v) => setNumber('riskCriticalHours', v)} />
            <RuleField label={zh ? '高风险' : 'High'} value={draft.riskHighHours} unit="h" min={1} max={336} onChange={(v) => setNumber('riskHighHours', v)} />
            <RuleField label={zh ? '临近' : 'Near'} value={draft.riskNearHours} unit="h" min={1} max={504} onChange={(v) => setNumber('riskNearHours', v)} />
            <RuleField label={zh ? '需准备' : 'Watch'} value={draft.riskWatchHours} unit="h" min={1} max={720} onChange={(v) => setNumber('riskWatchHours', v)} />
          </div>
        </RuleCard>

        <RuleCard eyebrow="TIME BOXING" title={zh ? '行动装箱' : 'Action planning'} description={zh ? '控制 Today 在有限时间里如何保护硬任务、限制低杠杆事项。' : 'Controls how Today protects hard tasks and limits lower-leverage work.'}>
          <RuleField label={zh ? '允许为近截止额外增加' : 'Near-deadline stretch'} value={draft.nearDeadlineStretchMinutes} unit={zh ? '分钟' : 'min'} min={0} max={180} onChange={(v) => setNumber('nearDeadlineStretchMinutes', v)} />
          <RuleField label={zh ? '每日最多流程复核' : 'Max follow-ups / day'} value={draft.followUpDailyCap} unit={zh ? '项' : 'items'} min={0} max={10} onChange={(v) => setNumber('followUpDailyCap', v)} />
          <RuleField label={zh ? '每日最多准备任务' : 'Max prep / day'} value={draft.prepDailyCap} unit={zh ? '项' : 'items'} min={0} max={10} onChange={(v) => setNumber('prepDailyCap', v)} />
        </RuleCard>

        <RuleCard eyebrow="VISIBILITY" title={zh ? '近期视野' : 'Planning horizon'} description={zh ? '控制 Today 提前看多远，以及最多展示多少个未来节点。' : 'Controls how far Today looks ahead and how many future nodes it surfaces.'}>
          <RuleField label={zh ? '近期节点范围' : 'Upcoming horizon'} value={draft.upcomingHorizonDays} unit={zh ? '天' : 'days'} min={1} max={30} onChange={(v) => setNumber('upcomingHorizonDays', v)} />
          <RuleField label={zh ? '最多显示节点' : 'Max visible nodes'} value={draft.upcomingNodeLimit} unit={zh ? '个' : 'nodes'} min={1} max={50} onChange={(v) => setNumber('upcomingNodeLimit', v)} />
        </RuleCard>

        <details className="rules-card advanced-rules">
          <summary>
            <div><span className="eyebrow">TODAY RANKING</span><strong>{zh ? 'Today 排序因子权重' : 'Today ranking weights'}</strong></div>
            <span>{zh ? '高级设置' : 'Advanced'}</span>
          </summary>
          <p>{zh ? '这些权重控制行动排序。系统会自动归一化，不要求总和等于 100。' : 'These weights control action ranking and are normalized automatically.'}</p>
          <div className="weight-grid">
            {weightKeys.map((key) => (
              <RuleField key={key} label={weightLabels[key][zh ? 0 : 1]} value={draft.weights[key]} unit="w" min={0} max={100} step={1} onChange={(v) => setWeight(key, v)} />
            ))}
          </div>
        </details>

        <details className="rules-card advanced-rules">
          <summary>
            <div><span className="eyebrow">FIT MODEL</span><strong>{zh ? '匹配度组件权重' : 'Fit component weights'}</strong></div>
            <span>{zh ? '评估策略' : 'Assessment policy'}</span>
          </summary>
          <p>{zh ? 'AI 提交各分项分数、置信度与依据；PJSDAS 只对已提供分项按这些权重重新归一化。缺失项降低覆盖度和置信度，不会被偷偷填成中性分。' : 'AI supplies component score, confidence, and rationale; PJSDAS aggregates only supplied components using these weights. Missing components reduce coverage and confidence rather than being imputed with a neutral score.'}</p>
          <div className="weight-grid">
            {fitComponentWeightKeys.map((key) => (
              <RuleField key={key} label={fitComponentLabels[key][zh ? 0 : 1]} value={draft.fitComponentWeights![key]} unit="w" min={0} max={100} step={1} onChange={(v) => setFitComponentWeight(key, v)} />
            ))}
          </div>
        </details>

        <details className="rules-card advanced-rules">
          <summary>
            <div><span className="eyebrow">OPPORTUNITY VALUE MODEL</span><strong>{zh ? '机会价值组件权重' : 'Opportunity Value component weights'}</strong></div>
            <span>{zh ? '评估策略' : 'Assessment policy'}</span>
          </summary>
          <p>{zh ? '公司质量、岗位成长、薪资、职业选择权、品牌、行业成长和地点价值共同形成新岗位的 Opportunity Value。权重只影响后续评估或显式当前规则投影，不会静默修改历史记录。' : 'Company quality, role growth, compensation, career optionality, brand, industry growth, and location value form Opportunity Value for new assessments. Weight changes affect future assessments or explicit current-rule projections, not stored history silently.'}</p>
          <div className="weight-grid">
            {opportunityComponentWeightKeys.map((key) => (
              <RuleField key={key} label={opportunityComponentLabels[key][zh ? 0 : 1]} value={draft.opportunityValueComponentWeights![key]} unit="w" min={0} max={100} step={1} onChange={(v) => setOpportunityComponentWeight(key, v)} />
            ))}
          </div>
        </details>
      </div>

      {errors.length > 0 ? <div className="rules-error">{errors.map((item) => <div key={item}>{item}</div>)}</div> : null}
      {message ? <div className="rules-message">{message}</div> : null}

      <div className="rules-footer">
        <div>
          <strong>{dirty ? (zh ? '有未保存修改' : 'Unsaved changes') : (zh ? '当前规则已保存' : 'Rules are saved')}</strong>
          <small>{zh ? '网站和 ChatGPT / MCP 都通过同一种 ChangeSet 修改这份结构化规则；历史岗位评估保留审计语义。' : 'Website and ChatGPT / MCP changes use the same ChangeSet protocol; historical opportunity assessments retain audit semantics.'}</small>
        </div>
        <div className="rules-actions">
          <button className="rules-reset" disabled={busy || JSON.stringify(draft) === JSON.stringify(cloneDecisionRules(DEFAULT_DECISION_RULES))} onClick={reset}>{zh ? '恢复推荐值' : 'Restore defaults'}</button>
          <button className="primary-button" disabled={busy || !dirty || errors.length > 0} onClick={save}>{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存规则' : 'Save rules')}</button>
        </div>
      </div>
    </section>
  )
}

function RuleSummary({ label, value }: { label: string; value: string }) {
  return <div className="rule-summary"><span>{label}</span><strong>{value}</strong></div>
}

function RuleCard({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <article className="rules-card">
      <div className="eyebrow">{eyebrow}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="rule-fields">{children}</div>
    </article>
  )
}

function RuleField({ label, value, unit, min, max, step = 1, onChange }: { label: string; value: number; unit: string; min: number; max: number; step?: number; onChange: (value: string) => void }) {
  return (
    <label className="rule-field">
      <span>{label}</span>
      <div><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(event.target.value)} /><small>{unit}</small></div>
    </label>
  )
}
