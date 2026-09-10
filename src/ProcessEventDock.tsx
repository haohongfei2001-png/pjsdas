import { useEffect, useMemo, useState } from 'react'
import {
  applyProcessEventChangeSet,
  applyProcessEventDeleteChangeSet,
  getAllOpportunities,
  getAllProcessEvents,
} from './db'
import {
  createProcessEvent,
  defaultMinutesForProcessEvent,
  defaultTimingModeForProcessEvent,
  isActionableProcessEvent,
  processEventLabels,
  processEventStageLabel,
} from './processEvents'
import type {
  ActionTimingMode,
  Opportunity,
  ProcessEvent,
  ProcessEventType,
} from './model'
import './processEvents.css'

interface ProcessEventDockProps {
  onChanged?: () => void
}

function localDateTimeValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function toIso(value: string) {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function opportunityLabel(opportunity: Opportunity) {
  return `${opportunity.company}｜${opportunity.role} [${opportunity.id}]`
}

function effectiveTimingMode(event: ProcessEvent) {
  return event.timingMode ?? defaultTimingModeForProcessEvent(event.type)
}

export default function ProcessEventDock({ onChanged }: ProcessEventDockProps) {
  const [open, setOpen] = useState(false)
  const [opportunities, setOpportunities] = useState<Opportunity[]>([])
  const [events, setEvents] = useState<ProcessEvent[]>([])
  const [opportunityText, setOpportunityText] = useState('')
  const [type, setType] = useState<ProcessEventType>('assessment_invite')
  const [timingMode, setTimingMode] = useState<ActionTimingMode>('deadline')
  const [occurredAt, setOccurredAt] = useState(localDateTimeValue())
  const [dueAt, setDueAt] = useState('')
  const [estimatedMinutes, setEstimatedMinutes] = useState(
    defaultMinutesForProcessEvent('assessment_invite'),
  )
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function reloadLocal() {
    const [nextOpportunities, nextEvents] = await Promise.all([
      getAllOpportunities(),
      getAllProcessEvents(),
    ])
    setOpportunities(nextOpportunities)
    setEvents(nextEvents.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)))
  }

  useEffect(() => {
    reloadLocal()
  }, [])

  useEffect(() => {
    setEstimatedMinutes(defaultMinutesForProcessEvent(type))
    setTimingMode(defaultTimingModeForProcessEvent(type))
  }, [type])

  const opportunityByLabel = useMemo(
    () => new Map(opportunities.map((item) => [opportunityLabel(item), item])),
    [opportunities],
  )
  const actionable = isActionableProcessEvent(type)
  const interview = type === 'interview_invite'

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    const opportunity = opportunityByLabel.get(opportunityText)
    if (!opportunity) {
      setError('请选择岗位列表中的完整公司与岗位。')
      return
    }
    const occurredIso = toIso(occurredAt)
    if (!occurredIso) {
      setError('通知时间无效。')
      return
    }
    if (actionable && !dueAt) {
      setError('测评、笔试和面试通知必须填写真实截止或固定发生时间，避免制造无期限任务。')
      return
    }
    const dueIso = toIso(dueAt)
    if (dueAt && !dueIso) {
      setError('截止或固定发生时间无效。')
      return
    }

    setBusy(true)
    try {
      const processEvent = createProcessEvent({
        opportunity,
        type,
        occurredAt: occurredIso,
        dueAt: dueIso,
        timingMode: interview ? 'fixed' : timingMode,
        estimatedMinutes: Math.max(5, Math.round(estimatedMinutes || 5)),
        notes,
        source: 'manual',
      })
      await applyProcessEventChangeSet(processEvent)
      await reloadLocal()
      setOpportunityText('')
      setDueAt('')
      setNotes('')
      setOccurredAt(localDateTimeValue())
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存流程事件失败。')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    setError('')
    try {
      await applyProcessEventDeleteChangeSet(id)
      await reloadLocal()
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '删除流程事件失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="event-dock-trigger" type="button" onClick={() => setOpen(true)}>
        + 记录流程通知
      </button>

      {open ? (
        <div className="event-dock-backdrop" onMouseDown={() => setOpen(false)}>
          <aside className="event-dock" onMouseDown={(event) => event.stopPropagation()}>
            <div className="event-dock-header">
              <div>
                <div className="eyebrow">PROCESS EVENT</div>
                <h2>记录真实流程通知</h2>
                <p>只记录实际收到的通知。测评、笔试、面试会自动生成 Today 行动。</p>
              </div>
              <button className="event-close" type="button" onClick={() => setOpen(false)} aria-label="关闭">
                ×
              </button>
            </div>

            {opportunities.length === 0 ? (
              <div className="event-empty">先在 Import & Settings 导入秋招投递表。</div>
            ) : (
              <form className="event-form" onSubmit={submit}>
                <label>
                  <span>岗位</span>
                  <input
                    list="process-event-opportunities"
                    value={opportunityText}
                    onChange={(event) => setOpportunityText(event.target.value)}
                    placeholder="输入公司名后从列表选择"
                  />
                  <datalist id="process-event-opportunities">
                    {opportunities.map((item) => (
                      <option key={item.id} value={opportunityLabel(item)} />
                    ))}
                  </datalist>
                </label>

                <div className="event-form-grid">
                  <label>
                    <span>事件</span>
                    <select value={type} onChange={(event) => setType(event.target.value as ProcessEventType)}>
                      {Object.entries(processEventLabels).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>预计耗时</span>
                    <div className="event-number-row">
                      <input
                        type="number"
                        min={5}
                        step={5}
                        value={estimatedMinutes}
                        onChange={(event) => setEstimatedMinutes(Number(event.target.value))}
                      />
                      <small>分钟</small>
                    </div>
                  </label>
                </div>

                {actionable ? (
                  <label>
                    <span>时间性质</span>
                    <select
                      value={interview ? 'fixed' : timingMode}
                      disabled={interview}
                      onChange={(event) => setTimingMode(event.target.value as ActionTimingMode)}
                    >
                      <option value="deadline">截止时间｜可提前完成</option>
                      <option value="fixed">固定时间｜只能到点进行</option>
                    </select>
                    <small className="event-field-help">
                      {interview
                        ? '面试按固定时间处理，不会被当成今天可以提前完成的任务。'
                        : timingMode === 'deadline'
                          ? '例如：明晚 23:59 前完成测评。PJSDAS 可以把它提前安排到今天。'
                          : '例如：明天 19:00 统一笔试。PJSDAS 只在发生当天占用时间预算。'}
                    </small>
                  </label>
                ) : null}

                <div className="event-form-grid">
                  <label>
                    <span>收到通知时间</span>
                    <input type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} />
                  </label>
                  <label>
                    <span>
                      {actionable
                        ? (interview || timingMode === 'fixed' ? '固定开始时间 *' : '截止时间 *')
                        : '关联时间（可选）'}
                    </span>
                    <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
                  </label>
                </div>

                <label>
                  <span>备注（可选）</span>
                  <textarea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="例如：邮件要求摄像头、面试平台、需要准备的材料"
                    rows={3}
                  />
                </label>

                {error ? <div className="event-error">{error}</div> : null}

                <div className="event-form-footer">
                  <small>
                    {actionable
                      ? '保存后会生成真实流程 Action；截止任务进入可提前安排的时间计划，固定事件只在发生当天占用预算。'
                      : '此类事件只更新事实时间线，不自动制造 Action。'}
                  </small>
                  <button className="primary-button" type="submit" disabled={busy}>
                    {busy ? '保存中…' : '保存事件'}
                  </button>
                </div>
              </form>
            )}

            <div className="event-history">
              <div className="event-history-title">
                <div>
                  <div className="eyebrow">LOCAL TIMELINE</div>
                  <strong>最近流程事件</strong>
                </div>
                <span>{events.length} 条</span>
              </div>

              {events.length === 0 ? (
                <div className="event-empty">还没有手动记录的流程事件。</div>
              ) : (
                <div className="event-history-list">
                  {events.slice(0, 10).map((item) => {
                    const mode = effectiveTimingMode(item)
                    return (
                      <article className="event-history-item" key={item.id}>
                        <div>
                          <strong>{item.company}｜{processEventLabels[item.type]}</strong>
                          <p>{item.role}</p>
                          <small>
                            {processEventStageLabel(item)} · 收到 {formatDateTime(item.occurredAt)}
                            {item.dueAt ? ` · ${mode === 'fixed' ? '固定' : '截止'} ${formatDateTime(item.dueAt)}` : ''}
                          </small>
                        </div>
                        <button type="button" disabled={busy} onClick={() => remove(item.id)}>删除</button>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  )
}

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}
