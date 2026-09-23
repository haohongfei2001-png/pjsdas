import { useMemo, useState } from 'react'
import { applyProcessEventChangeSet, getAllOpportunities } from './db.js'
import { parseRecruitingNotification } from './notificationParser.js'
import {
  createProcessEvent,
  defaultMinutesForProcessEvent,
  defaultTimingModeForProcessEvent,
  isActionableProcessEvent,
  processEventLabels,
} from './processEvents.js'
import type {
  ActionTimingMode,
  Opportunity,
  ProcessEventType,
} from './model.js'
import type { NotificationParseResult } from './notificationParser.js'
import './notificationPaste.css'

interface NotificationPasteDockProps {
  onChanged?: () => void
}

function opportunityLabel(opportunity: Opportunity) {
  return `${opportunity.company}｜${opportunity.role} [${opportunity.id}]`
}

function toLocalInput(iso?: string) {
  if (!iso) return ''
  const date = new Date(iso)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function inputToIso(value: string) {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

const confidenceLabels = {
  high: '高',
  medium: '中',
  low: '低',
} as const

export default function NotificationPasteDock({ onChanged }: NotificationPasteDockProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [opportunities, setOpportunities] = useState<Opportunity[]>([])
  const [result, setResult] = useState<NotificationParseResult | null>(null)
  const [opportunityText, setOpportunityText] = useState('')
  const [type, setType] = useState<ProcessEventType>('assessment_invite')
  const [timingMode, setTimingMode] = useState<ActionTimingMode>('deadline')
  const [dueAt, setDueAt] = useState('')
  const [estimatedMinutes, setEstimatedMinutes] = useState(45)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const opportunityByLabel = useMemo(
    () => new Map(opportunities.map((item) => [opportunityLabel(item), item])),
    [opportunities],
  )

  async function show() {
    setOpen(true)
    setError('')
    setOpportunities(await getAllOpportunities())
  }

  function applyResult(parsed: NotificationParseResult) {
    setResult(parsed)
    setOpportunityText(parsed.opportunity ? opportunityLabel(parsed.opportunity) : '')
    const nextType = parsed.type ?? 'other'
    setType(nextType)
    setTimingMode(parsed.timingMode ?? defaultTimingModeForProcessEvent(nextType))
    setDueAt(toLocalInput(parsed.dueAt))
    setEstimatedMinutes(parsed.estimatedMinutes ?? defaultMinutesForProcessEvent(nextType))
  }

  async function parse() {
    setError('')
    setMessage('')
    if (!text.trim()) {
      setError('先粘贴招聘通知文本。')
      return
    }
    const current = await getAllOpportunities()
    setOpportunities(current)
    if (current.length === 0) {
      setError('还没有岗位数据，请先导入秋招投递表。')
      return
    }
    applyResult(parseRecruitingNotification(text, current, new Date()))
  }

  function chooseCandidate(opportunity: Opportunity) {
    setOpportunityText(opportunityLabel(opportunity))
  }

  function changeType(nextType: ProcessEventType) {
    setType(nextType)
    const nextTiming = defaultTimingModeForProcessEvent(nextType)
    setTimingMode(nextTiming)
    setEstimatedMinutes(defaultMinutesForProcessEvent(nextType))
  }

  async function confirm() {
    setError('')
    setMessage('')
    const opportunity = opportunityByLabel.get(opportunityText)
    if (!opportunity) {
      setError('必须确认一个现有岗位后才能保存。')
      return
    }
    const actionable = isActionableProcessEvent(type)
    const dueIso = inputToIso(dueAt)
    if (actionable && !dueIso) {
      setError('测评、笔试和面试必须确认真实截止或固定发生时间。')
      return
    }

    setBusy(true)
    try {
      const event = createProcessEvent({
        opportunity,
        type,
        occurredAt: result?.occurredAt ?? new Date().toISOString(),
        dueAt: dueIso,
        timingMode: type === 'interview_invite' ? 'fixed' : timingMode,
        estimatedMinutes: Math.max(5, Math.round(estimatedMinutes || 5)),
        notes,
        source: 'manual',
      })
      const applied = await applyProcessEventChangeSet(event)
      setMessage(`已通过 ChangeSet ${applied.id} 保存流程事件；粘贴的原始通知文本没有写入本地数据库。`)
      setResult(null)
      setText('')
      setOpportunityText('')
      setDueAt('')
      setNotes('')
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败。')
    } finally {
      setBusy(false)
    }
  }

  const actionable = isActionableProcessEvent(type)
  const fixed = type === 'interview_invite' ? true : timingMode === 'fixed'

  return (
    <>
      <button className="paste-dock-trigger" type="button" onClick={show}>粘贴通知</button>
      {open ? (
        <div className="paste-backdrop" onMouseDown={() => setOpen(false)}>
          <section className="paste-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <div className="paste-header">
              <div>
                <div className="eyebrow">PARSE → REVIEW → SAVE</div>
                <h2>粘贴招聘通知</h2>
                <p>解析仅用于预填。任何岗位、事件或时间判断都可以在保存前修改。</p>
              </div>
              <button className="paste-close" type="button" onClick={() => setOpen(false)} aria-label="关闭">×</button>
            </div>

            <label className="paste-source">
              <span>通知原文</span>
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="粘贴短信、邮件或招聘系统通知，例如：××公司面试通知：请于9月12日19:30参加线上面试……"
                rows={6}
              />
            </label>
            <div className="paste-source-footer">
              <small>原文仅在当前输入框中用于解析；确认保存时默认不存原文。</small>
              <button type="button" className="primary-button" onClick={parse} disabled={busy}>解析通知</button>
            </div>

            {error ? <div className="paste-notice error">{error}</div> : null}
            {message ? <div className="paste-notice success">{message}</div> : null}

            {result ? (
              <div className="paste-review">
                <div className="paste-confidence">
                  <span>岗位 <strong data-level={result.confidence.opportunity}>{confidenceLabels[result.confidence.opportunity]}</strong></span>
                  <span>事件 <strong data-level={result.confidence.type}>{confidenceLabels[result.confidence.type]}</strong></span>
                  <span>时间 <strong data-level={result.confidence.time}>{confidenceLabels[result.confidence.time]}</strong></span>
                </div>

                {result.warnings.length > 0 ? (
                  <div className="paste-warnings">
                    {result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
                  </div>
                ) : null}

                {!result.opportunity && result.candidates.length > 0 ? (
                  <div className="paste-candidates">
                    <span>可能的岗位</span>
                    <div>
                      {result.candidates.slice(0, 4).map((candidate) => (
                        <button type="button" key={candidate.opportunity.id} onClick={() => chooseCandidate(candidate.opportunity)}>
                          {candidate.opportunity.company}｜{candidate.opportunity.role}
                          <small>{candidate.score}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="paste-form-grid">
                  <label className="paste-wide">
                    <span>确认岗位</span>
                    <input
                      list="paste-opportunities"
                      value={opportunityText}
                      onChange={(event) => setOpportunityText(event.target.value)}
                      placeholder="输入公司名并从列表选择"
                    />
                    <datalist id="paste-opportunities">
                      {opportunities.map((item) => <option key={item.id} value={opportunityLabel(item)} />)}
                    </datalist>
                  </label>

                  <label>
                    <span>事件类型</span>
                    <select value={type} onChange={(event) => changeType(event.target.value as ProcessEventType)}>
                      {Object.entries(processEventLabels).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span>预计耗时</span>
                    <input type="number" min={5} step={5} value={estimatedMinutes} onChange={(event) => setEstimatedMinutes(Number(event.target.value))} />
                  </label>

                  {actionable ? (
                    <label>
                      <span>时间性质</span>
                      <select
                        value={fixed ? 'fixed' : timingMode}
                        disabled={type === 'interview_invite'}
                        onChange={(event) => setTimingMode(event.target.value as ActionTimingMode)}
                      >
                        <option value="deadline">截止时间｜可提前完成</option>
                        <option value="fixed">固定时间｜只能到点进行</option>
                      </select>
                    </label>
                  ) : null}

                  <label>
                    <span>{actionable ? (fixed ? '固定开始时间' : '截止时间') : '关联时间（可选）'}</span>
                    <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
                  </label>

                  <label className="paste-wide">
                    <span>备注（可选）</span>
                    <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="只保存真正需要长期保留的信息" />
                  </label>
                </div>

                <div className="paste-confirm">
                  <small>点击保存后会先生成并应用 ChangeSet，再写入 Process Event 并更新 Pipeline / Today。</small>
                  <button className="primary-button" type="button" disabled={busy} onClick={confirm}>
                    {busy ? '保存中…' : '确认并保存'}
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  )
}
