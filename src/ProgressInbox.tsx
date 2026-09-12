import { useState } from 'react'
import {
  applyChangeSet,
  discardChangeSet,
  getAllOpportunities,
  getAllProcessEvents,
  savePendingChangeSet,
} from './db.js'
import { getAllActionsForMutationBaseline } from './mutationBaselines.js'
import {
  parseProgressUpdate,
  progressOperationSummary,
  type ProgressUpdatePlan,
} from './progressUpdate.js'
import { createCanonicalProgressChangeSet } from './progressCompletion.js'
import type { Opportunity } from './model.js'
import type { ChangeSetRecord } from './changeSet.js'
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
  const [changeSet, setChangeSet] = useState<ChangeSetRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function show() {
    setOpen(true)
    setMessage('')
    setError('')
    setOpportunities(await getAllOpportunities())
  }

  async function parse() {
    setMessage('')
    setError('')
    if (!text.trim()) {
      setError('先输入最近的求职历程或接下来安排。')
      return
    }
    setBusy(true)
    try {
      const [current, processEvents, actions] = await Promise.all([
        getAllOpportunities(),
        getAllProcessEvents(),
        getAllActionsForMutationBaseline(),
      ])
      setOpportunities(current)
      if (current.length === 0) {
        setError('还没有岗位基线，请先导入一次秋招投递表。之后即可只用自然语言维护。')
        return
      }
      if (changeSet?.status === 'pending') await discardChangeSet(changeSet.id)
      const nextPlan = parseProgressUpdate(text, current, new Date())
      const canonical = nextPlan.executable.length > 0
        ? createCanonicalProgressChangeSet(nextPlan.executable, processEvents, actions)
        : undefined
      const nextChangeSet = canonical ? await savePendingChangeSet(canonical) : null
      setPlan(nextPlan)
      setChangeSet(nextChangeSet)
      if (nextPlan.executable.length > 0 && !canonical) {
        setMessage('识别到的进展已经是当前工作区状态，无需重复写入或生成 ChangeSet。')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法生成 ChangeSet。')
    } finally {
      setBusy(false)
    }
  }

  async function close() {
    if (changeSet?.status === 'pending') await discardChangeSet(changeSet.id)
    setPlan(null)
    setChangeSet(null)
    setOpen(false)
  }

  async function confirm() {
    if (!plan || !changeSet || changeSet.operations.length === 0) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const applied = await applyChangeSet(changeSet.id)
      const notes: string[] = []
      if (plan.unresolved.length > 0) notes.push(`${plan.unresolved.length} 条歧义未写入`)
      if (plan.ignored.length > 0) notes.push(`${plan.ignored.length} 条背景记录无需写入`)
      setMessage(`ChangeSet ${applied.id} 已应用 ${applied.operations.length} 项修改${notes.length ? `；${notes.join('，')}。` : '。'}`)
      setText('')
      setPlan(null)
      setChangeSet(null)
      setOpportunities(await getAllOpportunities())
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '更新失败。')
    } finally {
      setBusy(false)
    }
  }

  function canonicalOperationFor(operationId: string) {
    return changeSet?.operations.find((item) => item.id === `progress:${operationId}`)
  }

  return (
    <>
      <button className="progress-inbox-trigger" type="button" onClick={show}>
        更新求职进展
      </button>
      {open ? (
        <div className="progress-inbox-backdrop" onMouseDown={() => { void close() }}>
          <section className="progress-inbox-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header className="progress-inbox-header">
              <div>
                <div className="eyebrow">NATURAL LANGUAGE UPDATE</div>
                <h2>把历程和安排直接告诉 PJSDAS</h2>
                <p>
                  可以一次粘贴多天记录。系统先生成持久化 ChangeSet，只有你确认后才修改业务数据；ChangeSet 只保存规范化修改，原始输入默认不保存。
                </p>
              </div>
              <button type="button" className="progress-inbox-close" onClick={() => { void close() }} aria-label="关闭">×</button>
            </header>

            <textarea
              className="progress-inbox-textarea"
              rows={10}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={'例如：\n9月10日，投递某公司AI产品经理。收到在线测评，48小时完成。\n9月11日，某公司测评已完成。\n9月22日，某公司产品经理10点面试。'}
            />

            <div className="progress-inbox-toolbar">
              <small>Excel 只作为初始基线；确认后的本地更新优先于以后重新导入的旧表。</small>
              <button className="primary-button" type="button" onClick={parse} disabled={busy}>{busy ? '处理中…' : '解析并生成 ChangeSet'}</button>
            </div>

            {error ? <div className="progress-message error">{error}</div> : null}
            {message ? <div className="progress-message success">{message}</div> : null}

            {plan ? (
              <div className="progress-plan">
                <div className="progress-plan-heading">
                  <div>
                    <div className="eyebrow">CHANGESET · {changeSet?.id ?? 'NO WRITABLE CHANGE'}</div>
                    <h3>准备执行 {changeSet?.operations.length ?? 0} 项修改</h3>
                  </div>
                  <span>
                    {plan.unresolved.length > 0
                      ? `${plan.unresolved.length} 条待确认${plan.ignored.length ? ` · ${plan.ignored.length} 条无需写入` : ''}`
                      : plan.ignored.length > 0
                        ? `${plan.ignored.length} 条无需写入`
                        : changeSet
                          ? '可直接确认'
                          : '状态已是最新'}
                  </span>
                </div>

                <div className="progress-operation-list">
                  {plan.operations.map((operation) => {
                    const canonical = canonicalOperationFor(operation.id)
                    const executable = operation.kind !== 'unresolved' && operation.kind !== 'ignored'
                    const noOp = executable && !canonical && Boolean(changeSet || plan.executable.length > 0)
                    const canonicalActionCompletion = canonical?.kind === 'set_action_status' && canonical.status === 'done'
                    const stateClass = operation.kind === 'unresolved'
                      ? ' unresolved'
                      : operation.kind === 'ignored'
                        ? ' ignored'
                        : ''
                    const mark = operation.kind === 'unresolved'
                      ? '?'
                      : operation.kind === 'ignored'
                        ? '·'
                        : noOp
                          ? '='
                          : canonicalActionCompletion
                            ? '✓'
                            : operation.kind === 'close_opportunity'
                              ? '−'
                              : operation.kind === 'rename_opportunity'
                                ? '→'
                                : '+'
                    return (
                      <article key={operation.id} className={`progress-operation${stateClass}`}>
                        <div className="progress-operation-mark">{mark}</div>
                        <div>
                          <strong>{canonicalActionCompletion ? canonical.summary : progressOperationSummary(operation)}</strong>
                          <p>{operation.sourceText}</p>
                          {operation.kind === 'unresolved' && operation.candidates?.length ? (
                            <small>可能对应：{operation.candidates.map((item) => item.label).join('；')}</small>
                          ) : operation.kind === 'ignored' ? (
                            <small>已识别为背景记录 · 不修改岗位数据库</small>
                          ) : noOp ? (
                            <small>当前状态已经包含这条进展 · 不重复写入</small>
                          ) : canonicalActionCompletion ? (
                            <small>将已有流程 Action 标记为完成 · 不重复创建测评/笔试/面试事件</small>
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
                  <small>确认后严格按上方最终 ChangeSet 操作更新 Opportunities / Pipeline / Process Events / Actions；应用结果进入 Timeline，并立即重算 Today。</small>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={confirm}
                    disabled={busy || !changeSet || changeSet.operations.length === 0}
                  >
                    {busy ? '应用中…' : changeSet ? `确认并应用 ChangeSet · ${changeSet.operations.length} 项` : '无需应用'}
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
