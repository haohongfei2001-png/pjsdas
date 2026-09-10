from pathlib import Path

# ---------- new Decision Rules domain ----------
Path('src/decisionRules.ts').write_text(r'''export interface DecisionWeights {
  opportunity: number
  fit: number
  urgency: number
  stage: number
  leverage: number
  delayCost: number
  timeEfficiency: number
}

export interface DecisionRules {
  key: 'current'
  version: 1
  hardDeadlineHorizonHours: number
  fixedEventHorizonHours: number
  nearDeadlineStretchMinutes: number
  followUpDailyCap: number
  prepDailyCap: number
  upcomingHorizonDays: number
  upcomingNodeLimit: number
  riskCriticalHours: number
  riskHighHours: number
  riskNearHours: number
  riskWatchHours: number
  weights: DecisionWeights
  updatedAt: string
}

export const DEFAULT_DECISION_RULES: DecisionRules = {
  key: 'current',
  version: 1,
  hardDeadlineHorizonHours: 48,
  fixedEventHorizonHours: 48,
  nearDeadlineStretchMinutes: 30,
  followUpDailyCap: 2,
  prepDailyCap: 2,
  upcomingHorizonDays: 7,
  upcomingNodeLimit: 12,
  riskCriticalHours: 6,
  riskHighHours: 24,
  riskNearHours: 48,
  riskWatchHours: 72,
  weights: {
    opportunity: 19,
    fit: 12,
    urgency: 23,
    stage: 12,
    leverage: 15,
    delayCost: 12,
    timeEfficiency: 7,
  },
  updatedAt: '1970-01-01T00:00:00.000Z',
}

export function cloneDecisionRules(rules: DecisionRules = DEFAULT_DECISION_RULES): DecisionRules {
  return { ...rules, weights: { ...rules.weights } }
}

export function createDefaultDecisionRules(now = new Date().toISOString()): DecisionRules {
  return { ...DEFAULT_DECISION_RULES, weights: { ...DEFAULT_DECISION_RULES.weights }, updatedAt: now }
}

export function validateDecisionRules(rules: DecisionRules): string[] {
  const errors: string[] = []
  const integerRange = (label: string, value: number, min: number, max: number) => {
    if (!Number.isInteger(value) || value < min || value > max) errors.push(`${label} 必须是 ${min}–${max} 的整数。`)
  }

  integerRange('硬截止保护窗口', rules.hardDeadlineHorizonHours, 1, 336)
  integerRange('固定事件预告窗口', rules.fixedEventHorizonHours, 1, 336)
  integerRange('允许小幅超时', rules.nearDeadlineStretchMinutes, 0, 180)
  integerRange('每日复核上限', rules.followUpDailyCap, 0, 10)
  integerRange('每日准备上限', rules.prepDailyCap, 0, 10)
  integerRange('近期节点天数', rules.upcomingHorizonDays, 1, 30)
  integerRange('近期节点数量', rules.upcomingNodeLimit, 1, 50)
  integerRange('极高风险阈值', rules.riskCriticalHours, 1, 168)
  integerRange('高风险阈值', rules.riskHighHours, 1, 336)
  integerRange('临近阈值', rules.riskNearHours, 1, 504)
  integerRange('需准备阈值', rules.riskWatchHours, 1, 720)

  if (!(rules.riskCriticalHours <= rules.riskHighHours &&
    rules.riskHighHours <= rules.riskNearHours &&
    rules.riskNearHours <= rules.riskWatchHours)) {
    errors.push('风险阈值必须按 极高风险 ≤ 高风险 ≤ 临近 ≤ 需准备 递增。')
  }

  const weights = Object.values(rules.weights)
  if (weights.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
    errors.push('高级排序权重必须位于 0–100。')
  }
  if (weights.reduce((sum, value) => sum + value, 0) <= 0) {
    errors.push('高级排序权重不能全部为 0。')
  }
  return errors
}
''')

Path('src/RulesView.tsx').write_text(r'''import { useEffect, useMemo, useState } from 'react'
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
''')

Path('src/rules.css').write_text(r'''.rules-page { max-width: 1180px; }
.rules-summary-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-bottom:18px; }
.rule-summary { min-height:86px; display:flex; flex-direction:column; justify-content:space-between; padding:16px 18px; border:1px solid var(--border-soft, rgba(30,31,28,.09)); border-radius:16px; background:rgba(255,255,255,.56); }
.rule-summary span { color:#85867f; font-size:12px; }
.rule-summary strong { font-size:24px; letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
.rules-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.rules-card { border:1px solid rgba(30,31,28,.09); border-radius:18px; padding:20px 22px; background:rgba(255,255,255,.58); box-shadow:0 1px 0 rgba(255,255,255,.75) inset; }
.rules-card h2 { margin:5px 0 5px; font-size:20px; letter-spacing:-.025em; }
.rules-card > p { margin:0; color:#777872; font-size:12.5px; line-height:1.6; }
.rule-fields { display:grid; gap:11px; margin-top:18px; }
.rule-field { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:16px; align-items:center; min-height:46px; padding:8px 0; border-bottom:1px solid rgba(30,31,28,.055); }
.rule-field:last-child { border-bottom:0; }
.rule-field > span { color:#4f514c; font-size:13px; font-weight:620; }
.rule-field > div { display:flex; align-items:center; gap:7px; }
.rule-field input { width:76px; border:1px solid rgba(30,31,28,.13); border-radius:9px; padding:8px 9px; background:#fffdf8; color:#272824; text-align:right; font-variant-numeric:tabular-nums; outline:none; }
.rule-field input:focus { border-color:rgba(70,72,65,.4); box-shadow:0 0 0 3px rgba(70,72,65,.06); }
.rule-field small { min-width:38px; color:#96968f; font-size:11px; }
.risk-thresholds { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 16px; }
.advanced-rules { grid-column:1/-1; }
.advanced-rules summary { display:flex; justify-content:space-between; align-items:center; gap:18px; cursor:pointer; list-style:none; }
.advanced-rules summary::-webkit-details-marker { display:none; }
.advanced-rules summary strong { display:block; margin-top:5px; font-size:17px; }
.advanced-rules summary > span { color:#85867f; font-size:11px; }
.advanced-rules > p { margin:12px 0 0; }
.weight-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 22px; margin-top:12px; }
.rules-error,.rules-message { margin-top:14px; border-radius:12px; padding:12px 14px; font-size:12.5px; line-height:1.55; }
.rules-error { background:#f0ddd8; color:#784d45; }
.rules-message { background:#dfe7dc; color:#4f634b; }
.rules-footer { position:sticky; bottom:18px; z-index:5; display:flex; justify-content:space-between; align-items:center; gap:18px; margin-top:18px; padding:14px 16px; border:1px solid rgba(30,31,28,.11); border-radius:16px; background:rgba(250,248,242,.94); backdrop-filter:blur(16px); box-shadow:0 12px 30px rgba(30,31,28,.08); }
.rules-footer strong { display:block; font-size:13px; }
.rules-footer small { display:block; margin-top:3px; color:#8b8b84; font-size:11px; }
.rules-actions { display:flex; gap:8px; }
.rules-reset { border:1px solid rgba(30,31,28,.12); border-radius:10px; padding:10px 13px; background:rgba(255,255,255,.65); color:#65665f; font-weight:650; }
.rules-reset:disabled { opacity:.45; cursor:default; }
@media(max-width:900px){ .rules-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr));}.rules-grid{grid-template-columns:1fr}.advanced-rules{grid-column:auto} }
@media(max-width:620px){ .rules-summary-grid{grid-template-columns:1fr 1fr}.risk-thresholds,.weight-grid{grid-template-columns:1fr}.rules-footer{align-items:stretch;flex-direction:column}.rules-actions{width:100%}.rules-actions button{flex:1}.rule-field{grid-template-columns:1fr auto} }
''')

Path('tests/decisionRules.test.ts').write_text(r'''import { describe, expect, it } from 'vitest'
import { buildTimePlan, selectTodayActions } from '../src/decisionCoreV3'
import { createSnapshot, parseSnapshotText } from '../src/snapshot'
import { timeRisk } from '../src/timeRisk'
import {
  cloneDecisionRules,
  DEFAULT_DECISION_RULES,
  validateDecisionRules,
} from '../src/decisionRules'
import type { Action, RankedAction } from '../src/model'

function ranked(id: string, kind: Action['kind'], minutes = 10, dueAt?: string): RankedAction {
  return {
    action: {
      id,
      kind,
      title: id,
      dueAt,
      estimatedMinutes: minutes,
      leverage: 50,
      delayCost: 50,
      status: 'todo',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    },
    score: 80,
    breakdown: { opportunity: 50, fit: 50, urgency: 50, stage: 50, leverage: 50, delayCost: 50, timeEfficiency: 50 },
    reasons: [],
  }
}

describe('Decision Rules', () => {
  it('keeps the shipped defaults valid', () => {
    expect(validateDecisionRules(DEFAULT_DECISION_RULES)).toEqual([])
  })

  it('rejects risk thresholds that are out of order', () => {
    const rules = cloneDecisionRules()
    rules.riskCriticalHours = 30
    rules.riskHighHours = 24
    expect(validateDecisionRules(rules).join(' ')).toMatch(/风险阈值/)
  })

  it('respects editable daily follow-up and prep caps', () => {
    const rules = cloneDecisionRules()
    rules.followUpDailyCap = 1
    rules.prepDailyCap = 1
    const selected = selectTodayActions([
      ranked('f1', 'follow_up'), ranked('f2', 'follow_up'), ranked('p1', 'prep'), ranked('p2', 'prep'), ranked('m1', 'manual'),
    ], new Date('2026-09-10T09:00:00.000Z'), 10, rules)
    expect(selected.filter((x) => x.action.kind === 'follow_up')).toHaveLength(1)
    expect(selected.filter((x) => x.action.kind === 'prep')).toHaveLength(1)
  })

  it('changes hard-deadline protection without changing the task data', () => {
    const now = new Date('2026-09-10T00:00:00.000Z')
    const due36h = '2026-09-11T12:00:00.000Z'
    const hard = ranked('hard', 'apply', 90, due36h)
    const quick = ranked('quick', 'manual', 20)

    const protect48 = cloneDecisionRules()
    protect48.nearDeadlineStretchMinutes = 0
    const protectedPlan = buildTimePlan([quick, hard], 20, now, protect48)
    expect(protectedPlan.planned).toHaveLength(0)
    expect(protectedPlan.nearDeadlineUnplanned.map((x) => x.action.id)).toContain('hard')

    const protect24 = cloneDecisionRules()
    protect24.hardDeadlineHorizonHours = 24
    protect24.nearDeadlineStretchMinutes = 0
    const relaxedPlan = buildTimePlan([quick, hard], 20, now, protect24)
    expect(relaxedPlan.planned.map((x) => x.action.id)).toContain('quick')
  })

  it('uses editable countdown risk thresholds', () => {
    const now = new Date('2026-09-10T00:00:00.000Z')
    const due18h = '2026-09-10T18:00:00.000Z'
    expect(timeRisk(due18h, now).level).toBe('high')
    const rules = cloneDecisionRules()
    rules.riskHighHours = 12
    rules.riskNearHours = 36
    expect(timeRisk(due18h, now, rules).level).toBe('near')
  })

  it('round-trips rules in a local snapshot while remaining optional for old snapshots', () => {
    const rules = cloneDecisionRules()
    rules.followUpDailyCap = 1
    const snapshot = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], decisionRules: rules }, '2026-09-10T00:00:00.000Z')
    expect(parseSnapshotText(JSON.stringify(snapshot)).data.decisionRules?.followUpDailyCap).toBe(1)

    const legacy = { ...snapshot, data: { ...snapshot.data } }
    delete legacy.data.decisionRules
    expect(parseSnapshotText(JSON.stringify(legacy)).data.decisionRules).toBeUndefined()
  })
})
''')

# ---------- decision engine ----------
p = Path('src/decisionCoreV3.ts')
s = p.read_text()
model_import_end = "} from './model'\n"
if model_import_end not in s: raise SystemExit('decision model import anchor missing')
s = s.replace(model_import_end, model_import_end + "import { DEFAULT_DECISION_RULES, type DecisionRules } from './decisionRules'\n", 1)

old = """export function rankAction(
  action: Action,
  opportunity?: Opportunity,
  now = new Date(),
): RankedAction {
"""
new = """export function rankAction(
  action: Action,
  opportunity?: Opportunity,
  now = new Date(),
  rules: DecisionRules = DEFAULT_DECISION_RULES,
): RankedAction {
"""
if old not in s: raise SystemExit('rankAction signature missing')
s = s.replace(old, new, 1)

old_score = """  const score =
    breakdown.opportunity * 0.19 +
    breakdown.fit * 0.12 +
    breakdown.urgency * 0.23 +
    breakdown.stage * 0.12 +
    breakdown.leverage * 0.15 +
    breakdown.delayCost * 0.12 +
    breakdown.timeEfficiency * 0.07
"""
new_score = """  const weightTotal = Math.max(1, Object.values(rules.weights).reduce((sum, value) => sum + value, 0))
  const score = (
    breakdown.opportunity * rules.weights.opportunity +
    breakdown.fit * rules.weights.fit +
    breakdown.urgency * rules.weights.urgency +
    breakdown.stage * rules.weights.stage +
    breakdown.leverage * rules.weights.leverage +
    breakdown.delayCost * rules.weights.delayCost +
    breakdown.timeEfficiency * rules.weights.timeEfficiency
  ) / weightTotal
"""
if old_score not in s: raise SystemExit('score block missing')
s = s.replace(old_score, new_score, 1)
s = s.replace("hours <= 48) {\n    reasons.push('近期固定时间')", "hours <= rules.fixedEventHorizonHours) {\n    reasons.push('近期固定时间')", 1)
s = s.replace("hours >= 0 && hours <= 24) {\n    reasons.push(processTask ? '流程节点今天到期' : '今天硬截止')", "hours >= 0 && hours <= rules.riskHighHours) {\n    reasons.push(processTask ? '流程节点今天到期' : '今天硬截止')", 1)
s = s.replace("hardDeadlineAction && hours !== undefined && hours <= 48) {", "hardDeadlineAction && hours !== undefined && hours <= rules.hardDeadlineHorizonHours) {", 1)

old = "export function rankActions(actions: Action[], opportunities: Opportunity[], now = new Date()) {"
new = "export function rankActions(actions: Action[], opportunities: Opportunity[], now = new Date(), rules: DecisionRules = DEFAULT_DECISION_RULES) {"
if old not in s: raise SystemExit('rankActions signature missing')
s = s.replace(old, new, 1)
s = s.replace("        now,\n      ),", "        now,\n        rules,\n      ),", 1)

old = "export function selectTodayActions(ranked: RankedAction[], now = new Date(), limit = 10) {"
new = "export function selectTodayActions(ranked: RankedAction[], now = new Date(), limit = 10, rules: DecisionRules = DEFAULT_DECISION_RULES) {"
if old not in s: raise SystemExit('select signature missing')
s = s.replace(old, new, 1)
s = s.replace("hours >= 0 && hours <= 48\n", "hours >= 0 && hours <= rules.hardDeadlineHorizonHours\n", 1)
s = s.replace("if (followUps >= 2) continue", "if (followUps >= rules.followUpDailyCap) continue", 1)
s = s.replace("if (prepItems >= 2) continue", "if (prepItems >= rules.prepDailyCap) continue", 1)

old = """export function buildTimePlan(
  ranked: RankedAction[],
  budgetMinutes: number,
  now = new Date(),
): TimePlan {
"""
new = """export function buildTimePlan(
  ranked: RankedAction[],
  budgetMinutes: number,
  now = new Date(),
  rules: DecisionRules = DEFAULT_DECISION_RULES,
): TimePlan {
"""
if old not in s: raise SystemExit('buildTimePlan signature missing')
s = s.replace(old, new, 1)
s = s.replace("hours >= 0 && hours <= 48\n", "hours >= 0 && hours <= rules.fixedEventHorizonHours\n", 1)
s = s.replace("hours >= 0 && hours <= 48\n", "hours >= 0 && hours <= rules.hardDeadlineHorizonHours\n", 1)
s = s.replace("if (extraNeeded <= 30) {", "if (extraNeeded <= rules.nearDeadlineStretchMinutes) {", 1)
s = s.replace("const candidates = selectTodayActions(ranked, now, 24)", "const candidates = selectTodayActions(ranked, now, 24, rules)", 1)
# second cap pair in buildTimePlan
s = s.replace("if (followUps >= 2) continue", "if (followUps >= rules.followUpDailyCap) continue", 1)
s = s.replace("if (prepItems >= 2) continue", "if (prepItems >= rules.prepDailyCap) continue", 1)
p.write_text(s)

# ---------- decisionV3 wrapper ----------
p = Path('src/decisionV3.ts')
s = p.read_text()
s = s.replace("import type { Action, Opportunity } from './model'\n", "import type { Action, Opportunity } from './model'\nimport { DEFAULT_DECISION_RULES, type DecisionRules } from './decisionRules'\n", 1)
old = "export function rankActions(actions: Action[], opportunities: Opportunity[], now = new Date()) {"
new = "export function rankActions(actions: Action[], opportunities: Opportunity[], now = new Date(), rules: DecisionRules = DEFAULT_DECISION_RULES) {"
if old not in s: raise SystemExit('decisionV3 rank signature missing')
s = s.replace(old, new, 1)
s = s.replace("return rankActionsCore(normalized, opportunities, now).map((item) => {", "return rankActionsCore(normalized, opportunities, now, rules).map((item) => {", 1)
p.write_text(s)

# ---------- countdown risk ----------
p = Path('src/timeRisk.ts')
s = p.read_text()
s = s.replace("import type { Action, RankedAction } from './model'\n", "import type { Action, RankedAction } from './model'\nimport { DEFAULT_DECISION_RULES, type DecisionRules } from './decisionRules'\n", 1)
old = "export function timeRisk(dueAt: string, now = new Date()): TimeRisk {\n  const remainingMs = remainingTimeMs(dueAt, now)\n  if (remainingMs <= 6 * HOUR) return { level: 'critical', label: '极高风险', remainingMs }\n  if (remainingMs <= 24 * HOUR) return { level: 'high', label: '高风险', remainingMs }\n  if (remainingMs <= 48 * HOUR) return { level: 'near', label: '临近', remainingMs }\n  if (remainingMs <= 72 * HOUR) return { level: 'watch', label: '需准备', remainingMs }\n"
new = "export function timeRisk(dueAt: string, now = new Date(), rules: DecisionRules = DEFAULT_DECISION_RULES): TimeRisk {\n  const remainingMs = remainingTimeMs(dueAt, now)\n  if (remainingMs <= rules.riskCriticalHours * HOUR) return { level: 'critical', label: '极高风险', remainingMs }\n  if (remainingMs <= rules.riskHighHours * HOUR) return { level: 'high', label: '高风险', remainingMs }\n  if (remainingMs <= rules.riskNearHours * HOUR) return { level: 'near', label: '临近', remainingMs }\n  if (remainingMs <= rules.riskWatchHours * HOUR) return { level: 'watch', label: '需准备', remainingMs }\n"
if old not in s: raise SystemExit('timeRisk block missing')
s = s.replace(old, new, 1)
p.write_text(s)

# ---------- snapshot ----------
p = Path('src/snapshot.ts')
s = p.read_text()
s = s.replace("} from './model'\n", "} from './model'\nimport { validateDecisionRules, type DecisionRules } from './decisionRules'\n", 1)
s = s.replace("  applicationGroups: ApplicationGroup[]\n  meta?: ImportMeta\n", "  applicationGroups: ApplicationGroup[]\n  decisionRules?: DecisionRules\n  meta?: ImportMeta\n", 1)
anchor = """  assertArray(data.applicationGroups, 'applicationGroups')

  const opportunityIds = assertUniqueIds(data.opportunities, 'Opportunity')
"""
replacement = """  assertArray(data.applicationGroups, 'applicationGroups')
  if (data.decisionRules !== undefined) {
    if (!isObject(data.decisionRules)) throw new Error('备份损坏：decisionRules 格式无效。')
    const errors = validateDecisionRules(data.decisionRules as unknown as DecisionRules)
    if (errors.length) throw new Error(`备份损坏：决策规则无效（${errors[0]}）`)
  }

  const opportunityIds = assertUniqueIds(data.opportunities, 'Opportunity')
"""
if anchor not in s: raise SystemExit('snapshot validation anchor missing')
s = s.replace(anchor, replacement, 1)
p.write_text(s)

# ---------- IndexedDB persistence ----------
p = Path('src/db.ts')
s = p.read_text()
s = s.replace("import { createSnapshot, validateSnapshot, type PJSDASSnapshot } from './snapshot'\n", "import { createSnapshot, validateSnapshot, type PJSDASSnapshot } from './snapshot'\nimport { createDefaultDecisionRules, validateDecisionRules, type DecisionRules } from './decisionRules'\n", 1)
s = s.replace("  applicationGroups: { key: string; value: ApplicationGroup }\n  meta: { key: string; value: ImportMeta }\n", "  applicationGroups: { key: string; value: ApplicationGroup }\n  decisionRules: { key: string; value: DecisionRules }\n  meta: { key: string; value: ImportMeta }\n", 1)
s = s.replace("  'applicationGroups',\n  'meta',\n", "  'applicationGroups',\n  'decisionRules',\n  'meta',\n", 1)
s = s.replace("export const dbPromise = openDB<PJSDASDatabase>('pjsdas', 3, {", "export const dbPromise = openDB<PJSDASDatabase>('pjsdas', 4, {", 1)
upgrade_anchor = """    if (!db.objectStoreNames.contains('applicationGroups')) {
      db.createObjectStore('applicationGroups', { keyPath: 'id' })
    }
    if (!db.objectStoreNames.contains('meta')) {
"""
upgrade_new = """    if (!db.objectStoreNames.contains('applicationGroups')) {
      db.createObjectStore('applicationGroups', { keyPath: 'id' })
    }
    if (!db.objectStoreNames.contains('decisionRules')) {
      db.createObjectStore('decisionRules', { keyPath: 'key' })
    }
    if (!db.objectStoreNames.contains('meta')) {
"""
if upgrade_anchor not in s: raise SystemExit('db upgrade anchor missing')
s = s.replace(upgrade_anchor, upgrade_new, 1)

insert_anchor = """export async function getLastImport() {
  return (await dbPromise).get('meta', 'lastImport')
}

"""
insert = insert_anchor + """export async function getDecisionRules() {
  const stored = await (await dbPromise).get('decisionRules', 'current')
  return stored ?? createDefaultDecisionRules()
}

export async function saveDecisionRules(rules: DecisionRules) {
  const next: DecisionRules = { ...rules, weights: { ...rules.weights }, key: 'current', version: 1, updatedAt: new Date().toISOString() }
  const errors = validateDecisionRules(next)
  if (errors.length) throw new Error(errors[0])
  await (await dbPromise).put('decisionRules', next)
  return next
}

export async function resetDecisionRules() {
  const next = createDefaultDecisionRules()
  await (await dbPromise).put('decisionRules', next)
  return next
}

"""
if insert_anchor not in s: raise SystemExit('getLastImport anchor missing')
s = s.replace(insert_anchor, insert, 1)

old = """  const [opportunities, processes, processEvents, actions, prep, applicationGroups, meta] =
    await Promise.all([
      db.getAll('opportunities'),
      db.getAll('processes'),
      db.getAll('processEvents'),
      db.getAll('actions'),
      db.getAll('prep'),
      db.getAll('applicationGroups'),
      db.get('meta', 'lastImport'),
    ])

  return createSnapshot({
    opportunities,
    processes,
    processEvents,
    actions,
    prep,
    applicationGroups,
    meta,
  })
"""
new = """  const [opportunities, processes, processEvents, actions, prep, applicationGroups, decisionRules, meta] =
    await Promise.all([
      db.getAll('opportunities'),
      db.getAll('processes'),
      db.getAll('processEvents'),
      db.getAll('actions'),
      db.getAll('prep'),
      db.getAll('applicationGroups'),
      db.get('decisionRules', 'current'),
      db.get('meta', 'lastImport'),
    ])

  return createSnapshot({
    opportunities,
    processes,
    processEvents,
    actions,
    prep,
    applicationGroups,
    decisionRules: decisionRules ?? createDefaultDecisionRules(),
    meta,
  })
"""
if old not in s: raise SystemExit('snapshot export anchor missing')
s = s.replace(old, new, 1)
restore_anchor = """  for (const item of snapshot.data.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  if (snapshot.data.meta) await tx.objectStore('meta').put(snapshot.data.meta)
"""
restore_new = """  for (const item of snapshot.data.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  await tx.objectStore('decisionRules').put(snapshot.data.decisionRules ?? createDefaultDecisionRules())
  if (snapshot.data.meta) await tx.objectStore('meta').put(snapshot.data.meta)
"""
if restore_anchor not in s: raise SystemExit('snapshot restore anchor missing')
s = s.replace(restore_anchor, restore_new, 1)
p.write_text(s)

# ---------- App integration ----------
p = Path('src/AppV5.tsx')
s = p.read_text()
s = s.replace("  getAllProcesses,\n  getLastImport,\n", "  getAllProcesses,\n  getDecisionRules,\n  getLastImport,\n", 1)
s = s.replace("import { currentUiLanguage, useUiLanguage } from './uiLanguage'\n", "import { currentUiLanguage, useUiLanguage } from './uiLanguage'\nimport { DEFAULT_DECISION_RULES, type DecisionRules } from './decisionRules'\nimport RulesView from './RulesView'\n", 1)
s = s.replace("type Page = 'today' | 'opportunities' | 'pipeline' | 'prep' | 'settings'", "type Page = 'today' | 'opportunities' | 'pipeline' | 'prep' | 'rules' | 'settings'", 1)
s = s.replace("const navigation: Page[] = ['today', 'opportunities', 'pipeline', 'prep', 'settings']", "const navigation: Page[] = ['today', 'opportunities', 'pipeline', 'prep', 'rules', 'settings']", 1)
state_anchor = "  const [groups, setGroups] = useState<ApplicationGroup[]>([])\n"
if state_anchor not in s: raise SystemExit('App state anchor missing')
s = s.replace(state_anchor, state_anchor + "  const [rules, setRules] = useState<DecisionRules>(() => ({ ...DEFAULT_DECISION_RULES, weights: { ...DEFAULT_DECISION_RULES.weights } }))\n", 1)

old_reload = """    const [nextOpportunities, nextActions, nextProcesses, nextPrep, nextGroups, nextImport] =
      await Promise.all([
        getAllOpportunities(),
        getAllActions(),
        getAllProcesses(),
        getAllPrep(),
        getAllApplicationGroups(),
        getLastImport(),
      ])
"""
new_reload = """    const [nextOpportunities, nextActions, nextProcesses, nextPrep, nextGroups, nextRules, nextImport] =
      await Promise.all([
        getAllOpportunities(),
        getAllActions(),
        getAllProcesses(),
        getAllPrep(),
        getAllApplicationGroups(),
        getDecisionRules(),
        getLastImport(),
      ])
"""
if old_reload not in s: raise SystemExit('reload anchor missing')
s = s.replace(old_reload, new_reload, 1)
s = s.replace("    setGroups(nextGroups)\n    setLastImport(nextImport)\n", "    setGroups(nextGroups)\n    setRules(nextRules)\n    setLastImport(nextImport)\n", 1)
s = s.replace("const ranked = useMemo(() => rankActions(actions, opportunities, now), [actions, opportunities, now])", "const ranked = useMemo(() => rankActions(actions, opportunities, now, rules), [actions, opportunities, now, rules])", 1)

# navigation translation union
s = s.replace("'nav.today' | 'nav.opportunities' | 'nav.pipeline' | 'nav.prep' | 'nav.settings'", "'nav.today' | 'nav.opportunities' | 'nav.pipeline' | 'nav.prep' | 'nav.rules' | 'nav.settings'", 1)

# Today prop
call_anchor = """            opportunities={opportunities}
            groups={groups}
            onMark={markAction}
"""
call_new = """            opportunities={opportunities}
            groups={groups}
            rules={rules}
            onMark={markAction}
"""
if call_anchor not in s: raise SystemExit('Today call anchor missing')
s = s.replace(call_anchor, call_new, 1)
render_anchor = "        {!loading && page === 'prep' ? <PrepView prep={prep} /> : null}\n"
if render_anchor not in s: raise SystemExit('Rules render anchor missing')
s = s.replace(render_anchor, render_anchor + "        {!loading && page === 'rules' ? <RulesView rules={rules} onChanged={reload} /> : null}\n", 1)

sig_anchor = """  opportunities,
  groups,
  onMark,
}: {
  ranked: ReturnType<typeof rankActions>
  now: Date
  opportunities: Opportunity[]
  groups: ApplicationGroup[]
  onMark: (id: string, status: Action['status']) => Promise<void>
}) {
"""
sig_new = """  opportunities,
  groups,
  rules,
  onMark,
}: {
  ranked: ReturnType<typeof rankActions>
  now: Date
  opportunities: Opportunity[]
  groups: ApplicationGroup[]
  rules: DecisionRules
  onMark: (id: string, status: Action['status']) => Promise<void>
}) {
"""
if sig_anchor not in s: raise SystemExit('Today signature anchor missing')
s = s.replace(sig_anchor, sig_new, 1)
s = s.replace("const plan = buildTimePlan(ranked, budgetMinutes, now)", "const plan = buildTimePlan(ranked, budgetMinutes, now, rules)", 1)
s = s.replace("const upcoming = upcomingNodes(ranked, now, 7, 12)", "const upcoming = upcomingNodes(ranked, now, rules.upcomingHorizonDays, rules.upcomingNodeLimit)", 1)
# TimeRiskBadge calls in Today
s = s.replace("<TimeRiskBadge action={top.action} now={now} />", "<TimeRiskBadge action={top.action} now={now} rules={rules} />", 1)
s = s.replace("<TimeRiskBadge action={item.action} now={now} compact />", "<TimeRiskBadge action={item.action} now={now} rules={rules} compact />", 1)
s = s.replace("<TimeRiskBadge action={item.action} now={now} />", "<TimeRiskBadge action={item.action} now={now} rules={rules} />", 1)
# Dynamic warning text for configured window.
s = s.replace("未来 48 小时还有 ${plan.upcomingFixedEvents.length - 1} 个固定安排", "未来 ${rules.fixedEventHorizonHours} 小时还有 ${plan.upcomingFixedEvents.length - 1} 个固定安排", 1)
s = s.replace("为覆盖 48 小时内的下一硬截止", "为覆盖 ${rules.hardDeadlineHorizonHours} 小时内的下一硬截止", 1)
s = s.replace("48 小时内还有 {plan.nearDeadlineUnplanned.length} 个", "{rules.hardDeadlineHorizonHours} 小时内还有 {plan.nearDeadlineUnplanned.length} 个", 1)

old_badge = """function TimeRiskBadge({ action, now, compact = false }: { action: Action; now: Date; compact?: boolean }) {
  if (!action.dueAt) return null
  const risk = timeRisk(action.dueAt, now)
"""
new_badge = """function TimeRiskBadge({ action, now, rules, compact = false }: { action: Action; now: Date; rules: DecisionRules; compact?: boolean }) {
  if (!action.dueAt) return null
  const risk = timeRisk(action.dueAt, now, rules)
"""
if old_badge not in s: raise SystemExit('TimeRiskBadge anchor missing')
s = s.replace(old_badge, new_badge, 1)
p.write_text(s)

# ---------- nav i18n ----------
p = Path('src/uiLanguage.tsx')
s = p.read_text()
anchor = "  'nav.prep': ['准备', 'Prep'],\n"
if anchor not in s: raise SystemExit('uiLanguage nav anchor missing')
s = s.replace(anchor, anchor + "  'nav.rules': ['规则', 'Rules'],\n", 1)
p.write_text(s)
