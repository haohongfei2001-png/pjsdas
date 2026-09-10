import { useEffect, useMemo, useState } from 'react'
import { resetDecisionRules, saveDecisionRules } from './db'
import {
  cloneDecisionRules,
  DEFAULT_DECISION_RULES,
  validateDecisionRules,
  type DecisionRules,
  type DecisionWeights,
} from './decisionRules'
import { useUiLanguage } from './uiLanguage'
import './rules.css'

type Props = {
  rules: DecisionRules
  onChanged: () => Promise<void>
}

type NumericRuleKey = Exclude<keyof DecisionRules, 'key' | 'version' | 'weights' | 'updatedAt'>

const weightKeys: Array<keyof DecisionWeights> = [
  'opportunity', 'fit', 'urgency', 'stage', 'leverage', 'delayCost', 'timeEfficiency',
]

export default function RulesView({ rules, onChanged }: Props) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [draft, setDraft] = useState(() => cloneDecisionRules(rules))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => setDraft(cloneDecisionRules(rules)), [rules])

  const errors = useMemo(() => validateDecisionRules(draft), [draft])
  const dirty = JSON.stringify({ ...draft, updatedAt: '' }) !== JSON.stringify({ ...rules, updatedAt: '' })

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

  async function save() {
    if (errors.length) return
    setBusy(true)
    try {
      await saveDecisionRules(draft)
      await onChanged()
      setMessage(zh ? '规则已保存，Today 已按新规则重新计算。' : 'Rules saved. Today has been recalculated.')
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    setBusy(true)
    try {
      await resetDecisionRules()
      await onChanged()
      setMessage(zh ? '已恢复 PJSDAS 推荐规则。' : 'Recommended PJSDAS rules restored.')
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

  return (
    <section className="rules-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">DECISION RULES · V0.9</div>
          <h1>{zh ? '决策规则' : 'Decision Rules'}</h1>
          <p>{zh
            ? '这些规则直接驱动 Today 的排序、硬截止保护、近期节点和时间装箱。默认值就是此前 PJSDAS 的实际行为；修改后不会改你的岗位数据，只改变系统如何做决策。'
            : 'These rules directly drive Today ranking, deadline protection, upcoming nodes and time boxing. Defaults preserve the previous PJSDAS behavior; changing them changes decisions, not your job data.'}</p>
        </div>
      </header>

      <div className="rules-summary-grid">
        <RuleSummary label={zh ? '硬截止保护' : 'Deadline protection'} value={`${draft.hardDeadlineHorizonHours}h`} />
        <RuleSummary label={zh ? '近期节点' : 'Upcoming horizon'} value={`${draft.upcomingHorizonDays}${zh ? '天' : 'd'}`} />
        <RuleSummary label={zh ? '每日复核' : 'Daily reviews'} value={`${draft.followUpDailyCap}`} />
        <RuleSummary label={zh ? '每日准备' : 'Daily prep'} value={`${draft.prepDailyCap}`} />
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
            <div><span className="eyebrow">ADVANCED</span><strong>{zh ? '排序因子权重' : 'Ranking factor weights'}</strong></div>
            <span>{zh ? '高级设置' : 'Advanced'}</span>
          </summary>
          <p>{zh ? '这些权重决定同等时间约束下各因素的相对影响。系统会自动归一化，不要求总和等于 100。' : 'These weights control relative influence when time constraints are comparable. They are normalized automatically.'}</p>
          <div className="weight-grid">
            {weightKeys.map((key) => (
              <RuleField key={key} label={weightLabels[key][zh ? 0 : 1]} value={draft.weights[key]} unit="%" min={0} max={100} step={1} onChange={(v) => setWeight(key, v)} />
            ))}
          </div>
        </details>
      </div>

      {errors.length > 0 ? <div className="rules-error">{errors.map((item) => <div key={item}>{item}</div>)}</div> : null}
      {message ? <div className="rules-message">{message}</div> : null}

      <div className="rules-footer">
        <div>
          <strong>{dirty ? (zh ? '有未保存修改' : 'Unsaved changes') : (zh ? '当前规则已保存' : 'Rules are saved')}</strong>
          <small>{zh ? '未来 ChatGPT / MCP 修改规则时也会使用同一份结构化规则对象。' : 'Future ChatGPT / MCP rule changes will target this same structured rule object.'}</small>
        </div>
        <div className="rules-actions">
          <button className="rules-reset" disabled={busy || JSON.stringify(draft) === JSON.stringify(DEFAULT_DECISION_RULES)} onClick={reset}>{zh ? '恢复推荐值' : 'Restore defaults'}</button>
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
