import { useState } from 'react'
import { applyProgressUpdate, getAllOpportunities } from './db'
import {
  parseProgressUpdate,
  progressOperationSummary,
  type ProgressUpdatePlan,
} from './progressUpdate'
import type { Opportunity } from './model'
import './progressInbox.css'

interface ProgressInboxProps {
  onChanged?: () => void
}

const confidenceLabel = {
  high: '高置信度',
  medium: '需留意',
  low: '待确认',
} as const

export default function ProgressInbox({ onChanged }: ProgressInboxProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [opportunities, setOpportunities] = useState<Opportunity[]>([])
  const [plan, setPlan] = useState<ProgressUpdatePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function show() {
    setOpen(true)
    setMessage('')
    setError('')
    if (opportunities.length === 0) setOpportunities(await getAllOpportunities())
  }

  async function parse() {
    setMessage('')
    setError('')
    if (!text.trim()) {
      setError('先输入最近的求职历程或接下来安排。')
      return
    }
    let current = opportunities
    if (current.length === 0) {
      current = await getAllOpportunities()
      setOpportunities(current)
    }
    if (current.length === 0) {
      setError('还没有岗位基线，请先导入一次秋招投递表。之后即可只用自然语言维护。')
      return
    }
    setPlan(parseProgressUpdate(text, current, new Date()))
  }

  async function confirm() {
    if (!plan || plan.executable.length === 0) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await applyProgressUpdate(plan.executable)
      const notes: string[] = []
      if (plan.unresolved.length > 0) notes.push(`${plan.unresolved.length} 条歧义未写入`)
      if (plan.ignored.length > 0) notes.push(`${plan.ignored.length} 条背景记录无需写入`)
      setMessage(`已应用 ${result.applied} 项更新${notes.length ? `；${notes.join('，')}。` : '。'}`)
      setText('')
      setPlan(null)
      setOpportunities(await getAllOpportunities())
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '更新失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="progress-inbox-trigger" type="button" onClick={show}>
        更新求职进展
      </button>
      {open ? (
        <div className="progress-inbox-backdrop" onMouseDown={() => setOpen(false)}>
          <section className="progress-inbox-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header className="progress-inbox-header">
              <div>
                <div className="eyebrow">NATURAL LANGUAGE UPDATE</div>
                <h2>把历程和安排直接告诉 PJSDAS</h2>
                <p>
                  可以一次粘贴多天记录。系统先生成变更清单，只有你确认后才修改本地数据库；原文默认不保存。
                </p>
              </div>
              <button type="button" className="progress-inbox-close" onClick={() => setOpen(false)} aria-label="关闭">×</button>
            </header>

            <textarea
              className="progress-inbox-textarea"
              rows={10}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={'例如：\n9月10日，投递某公司AI产品经理。收到在线测评，48小时完成。\n9月11日，准备投递某公司产品经理和PMO经理。\n9月22日，某公司产品经理10点面试。'}
            />

            <div className="progress-inbox-toolbar">
              <small>Excel 只作为初始基线；确认后的本地更新优先于以后重新导入的旧表。</small>
              <button className="primary-button" type="button" onClick={parse} disabled={busy}>解析更新</button>
            </div>

            {error ? <div className="progress-message error">{error}</div> : null}
            {message ? <div className="progress-message success">{message}</div> : null}

            {plan ? (
              <div className="progress-plan">
                <div className="progress-plan-heading">
                  <div>
                    <div className="eyebrow">REVIEW DIFF</div>
                    <h3>准备执行 {plan.executable.length} 项修改</h3>
                  </div>
                  <span>
                    {plan.unresolved.length > 0
                      ? `${plan.unresolved.length} 条待确认${plan.ignored.length ? ` · ${plan.ignored.length} 条无需写入` : ''}`
                      : plan.ignored.length > 0
                        ? `${plan.ignored.length} 条无需写入`
                        : '可直接确认'}
                  </span>
                </div>

                <div className="progress-operation-list">
                  {plan.operations.map((operation) => {
                    const stateClass = operation.kind === 'unresolved'
                      ? ' unresolved'
                      : operation.kind === 'ignored'
                        ? ' ignored'
                        : ''
                    const mark = operation.kind === 'unresolved'
                      ? '?'
                      : operation.kind === 'ignored'
                        ? '·'
                        : operation.kind === 'close_opportunity'
                          ? '−'
                          : operation.kind === 'rename_opportunity'
                            ? '→'
                            : '+'
                    return (
                      <article key={operation.id} className={`progress-operation${stateClass}`}>
                        <div className="progress-operation-mark">{mark}</div>
                        <div>
                          <strong>{progressOperationSummary(operation)}</strong>
                          <p>{operation.sourceText}</p>
                          {operation.kind === 'unresolved' && operation.candidates?.length ? (
                            <small>可能对应：{operation.candidates.map((item) => item.label).join('；')}</small>
                          ) : operation.kind === 'ignored' ? (
                            <small>已识别为背景记录 · 不修改岗位数据库</small>
                          ) : (
                            <small>{confidenceLabel[operation.confidence]}</small>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>

                {plan.unresolved.length > 0 ? (
                  <div className="progress-message warning">
                    只有黄色“待确认”项不会自动写入。可以补全公司或岗位后重新解析；其他明确修改仍可先确认。
                  </div>
                ) : null}

                <div className="progress-confirm-row">
                  <small>确认后会直接更新 Opportunities / Pipeline / Process Events / Actions，并立即重算 Today。</small>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={confirm}
                    disabled={busy || plan.executable.length === 0}
                  >
                    {busy ? '更新中…' : `确认并应用 ${plan.executable.length} 项`}
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
