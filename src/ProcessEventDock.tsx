import { useEffect, useMemo, useState } from 'react'
import {
  applyProcessEventChangeSet,
  applyProcessEventDeleteChangeSet,
  getAllOpportunities,
  getAllProcessEvents,
} from './db.js'
import {
  createProcessEvent,
  defaultMinutesForProcessEvent,
  defaultTimingModeForProcessEvent,
  isActionableProcessEvent,
  processEventLabels,
  processEventStageLabel,
} from './processEvents.js'
import { useUiLanguage, type UiLanguage } from './uiLanguage.js'
import type {
  ActionTimingMode,
  Opportunity,
  ProcessEvent,
  ProcessEventType,
} from './model.js'
import './processEvents.css'

interface ProcessEventDockProps {
  onChanged?: () => void
}

const processEventLabelsEn: Record<ProcessEventType, string> = {
  assessment_invite: 'Assessment invitation',
  written_test_invite: 'Written-test invitation',
  interview_invite: 'Interview invitation',
  offer: 'Offer',
  rejection: 'Process closed / rejection',
  status_update: 'Process status update',
  other: 'Other progress',
}

const processEventStageLabelsEn: Record<ProcessEventType, string> = {
  assessment_invite: 'Assessment',
  written_test_invite: 'Written test',
  interview_invite: 'Interview',
  offer: 'Offer',
  rejection: 'Process closed',
  status_update: 'Status update',
  other: 'Other progress',
}

function eventLabel(type: ProcessEventType, lang: UiLanguage) {
  return lang === 'zh' ? processEventLabels[type] : processEventLabelsEn[type]
}

function stageLabel(event: ProcessEvent, lang: UiLanguage) {
  return lang === 'zh' ? processEventStageLabel(event) : processEventStageLabelsEn[event.type]
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
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
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
    void reloadLocal()
    const refresh = () => { void reloadLocal() }
    window.addEventListener('pjsdas:workspace-replaced', refresh)
    return () => window.removeEventListener('pjsdas:workspace-replaced', refresh)
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

  async function show() {
    setError('')
    await reloadLocal()
    setOpen(true)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    // Resolve against a freshly loaded workspace. The selected text may refer to
    // a role that was renamed/closed/replaced while this dock stayed mounted.
    const latestOpportunities = await getAllOpportunities()
    setOpportunities(latestOpportunities)
    const latestByLabel = new Map(latestOpportunities.map((item) => [opportunityLabel(item), item]))
    const opportunity = latestByLabel.get(opportunityText)
    if (!opportunity) {
      setError(zh
        ? '当前工作区已变化，请从最新岗位列表重新选择公司与岗位。'
        : 'The workspace changed. Select the company and role again from the latest opportunity list.')
      return
    }
    const occurredIso = toIso(occurredAt)
    if (!occurredIso) {
      setError(zh ? '通知时间无效。' : 'The notification time is invalid.')
      return
    }
    if (actionable && !dueAt) {
      setError(zh
        ? '测评、笔试和面试通知必须填写真实截止或固定发生时间，避免制造无期限任务。'
        : 'Assessment, written-test, and interview events require a real deadline or fixed time so PJSDAS does not create an open-ended task.')
      return
    }
    const dueIso = toIso(dueAt)
    if (dueAt && !dueIso) {
      setError(zh ? '截止或固定发生时间无效。' : 'The deadline or fixed event time is invalid.')
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
      setError(caught instanceof Error ? caught.message : (zh ? '保存流程事件失败。' : 'Could not save the process event.'))
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
      setError(caught instanceof Error ? caught.message : (zh ? '删除流程事件失败。' : 'Could not delete the process event.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="event-dock-trigger" type="button" onClick={() => { void show() }}>
        {zh ? '+ 记录流程通知' : '+ Record process event'}
      </button>

      {open ? (
        <div className="event-dock-backdrop" onMouseDown={() => setOpen(false)}>
          <aside className="event-dock" onMouseDown={(event) => event.stopPropagation()}>
            <div className="event-dock-header">
              <div>
                <div className="eyebrow">PROCESS EVENT</div>
                <h2>{zh ? '记录真实流程通知' : 'Record a real recruiting event'}</h2>
                <p>{zh
                  ? '只记录实际收到的通知。测评、笔试、面试会自动生成 Today 行动。'
                  : 'Record only events you actually received. Assessments, written tests, and interviews automatically create Today actions.'}</p>
              </div>
              <button className="event-close" type="button" onClick={() => setOpen(false)} aria-label={zh ? '关闭' : 'Close'}>
                ×
              </button>
            </div>

            {opportunities.length === 0 ? (
              <div className="event-empty">{zh
                ? '机会池还没有岗位。可在 Settings 配置岗位发现，或导入已有求职数据。'
                : 'The opportunity pool is empty. Configure discovery in Settings or import existing job-search data.'}</div>
            ) : (
              <form className="event-form" onSubmit={submit}>
                <label>
                  <span>{zh ? '岗位' : 'Opportunity'}</span>
                  <input
                    list="process-event-opportunities"
                    value={opportunityText}
                    onChange={(event) => setOpportunityText(event.target.value)}
                    placeholder={zh ? '输入公司名后从列表选择' : 'Type a company, then select from the list'}
                  />
                  <datalist id="process-event-opportunities">
                    {opportunities.map((item) => (
                      <option key={item.id} value={opportunityLabel(item)} />
                    ))}
                  </datalist>
                </label>

                <div className="event-form-grid">
                  <label>
                    <span>{zh ? '事件' : 'Event'}</span>
                    <select value={type} onChange={(event) => setType(event.target.value as ProcessEventType)}>
                      {(Object.keys(processEventLabels) as ProcessEventType[]).map((value) => (
                        <option key={value} value={value}>{eventLabel(value, lang)}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{zh ? '预计耗时' : 'Estimated time'}</span>
                    <div className="event-number-row">
                      <input
                        type="number"
                        min={5}
                        step={5}
                        value={estimatedMinutes}
                        onChange={(event) => setEstimatedMinutes(Number(event.target.value))}
                      />
                      <small>{zh ? '分钟' : 'min'}</small>
                    </div>
                  </label>
                </div>

                {actionable ? (
                  <label>
                    <span>{zh ? '时间性质' : 'Timing'}</span>
                    <select
                      value={interview ? 'fixed' : timingMode}
                      disabled={interview}
                      onChange={(event) => setTimingMode(event.target.value as ActionTimingMode)}
                    >
                      <option value="deadline">{zh ? '截止时间｜可提前完成' : 'Deadline | can be completed early'}</option>
                      <option value="fixed">{zh ? '固定时间｜只能到点进行' : 'Fixed time | occurs at that time'}</option>
                    </select>
                    <small className="event-field-help">
                      {interview
                        ? (zh ? '面试按固定时间处理，不会被当成今天可以提前完成的任务。' : 'Interviews are fixed-time events and are never treated as tasks that can be completed early today.')
                        : timingMode === 'deadline'
                          ? (zh ? '例如：明晚 23:59 前完成测评。PJSDAS 可以把它提前安排到今天。' : 'Example: complete an assessment by 23:59 tomorrow. PJSDAS may schedule it earlier today.')
                          : (zh ? '例如：明天 19:00 统一笔试。PJSDAS 只在发生当天占用时间预算。' : 'Example: a written test at 19:00 tomorrow. It consumes time budget only on the day it occurs.')}
                    </small>
                  </label>
                ) : null}

                <div className="event-form-grid">
                  <label>
                    <span>{zh ? '收到通知时间' : 'Notification received'}</span>
                    <input type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} />
                  </label>
                  <label>
                    <span>
                      {actionable
                        ? (interview || timingMode === 'fixed'
                            ? (zh ? '固定开始时间 *' : 'Fixed start time *')
                            : (zh ? '截止时间 *' : 'Deadline *'))
                        : (zh ? '关联时间（可选）' : 'Related time (optional)')}
                    </span>
                    <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
                  </label>
                </div>

                <label>
                  <span>{zh ? '备注（可选）' : 'Notes (optional)'}</span>
                  <textarea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder={zh ? '例如：邮件要求摄像头、面试平台、需要准备的材料' : 'For example: camera requirement, interview platform, or materials to prepare'}
                    rows={3}
                  />
                </label>

                {error ? <div className="event-error">{error}</div> : null}

                <div className="event-form-footer">
                  <small>
                    {actionable
                      ? (zh
                          ? '保存后会生成真实流程 Action；截止任务进入可提前安排的时间计划，固定事件只在发生当天占用预算。'
                          : 'Saving creates a real process Action. Deadline tasks may be scheduled early; fixed events consume time only on the day they occur.')
                      : (zh
                          ? '此类事件只更新事实时间线，不自动制造 Action。'
                          : 'This event updates factual history only and does not create an Action.')}
                  </small>
                  <button className="primary-button" type="submit" disabled={busy}>
                    {busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存事件' : 'Save event')}
                  </button>
                </div>
              </form>
            )}

            <div className="event-history">
              <div className="event-history-title">
                <div>
                  <div className="eyebrow">LOCAL TIMELINE</div>
                  <strong>{zh ? '最近流程事件' : 'Recent process events'}</strong>
                </div>
                <span>{events.length} {zh ? '条' : events.length === 1 ? 'event' : 'events'}</span>
              </div>

              {events.length === 0 ? (
                <div className="event-empty">{zh ? '还没有手动记录的流程事件。' : 'No manually recorded process events yet.'}</div>
              ) : (
                <div className="event-history-list">
                  {events.slice(0, 10).map((item) => {
                    const mode = effectiveTimingMode(item)
                    return (
                      <article className="event-history-item" key={item.id}>
                        <div>
                          <strong>{item.company}｜{eventLabel(item.type, lang)}</strong>
                          <p>{item.role}</p>
                          <small>
                            {stageLabel(item, lang)} · {zh ? '收到' : 'received'} {formatDateTime(item.occurredAt, lang)}
                            {item.dueAt ? ` · ${mode === 'fixed' ? (zh ? '固定' : 'fixed') : (zh ? '截止' : 'deadline')} ${formatDateTime(item.dueAt, lang)}` : ''}
                          </small>
                        </div>
                        <button type="button" disabled={busy} onClick={() => remove(item.id)}>{zh ? '删除' : 'Delete'}</button>
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

function formatDateTime(iso: string, lang: UiLanguage) {
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}
