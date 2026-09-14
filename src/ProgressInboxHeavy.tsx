import { useState } from 'react'
import {
  applyChangeSet,
  discardChangeSet,
  getAllOpportunities,
  getAllProcessEvents,
  savePendingChangeSet,
} from './db.js'
import { getAllDiscoveryInboxItems } from './discoveryInboxStore.js'
import { getAllActionsForMutationBaseline } from './mutationBaselines.js'
import {
  parseProgressUpdate,
  type CanonicalJobReference,
  type ProgressUpdatePlan,
} from './progressUpdate.js'
import { progressOperationSummaryForLanguage } from './progressOperationPresentation.js'
import { createCanonicalProgressChangeSet } from './progressCompletion.js'
import { useUiLanguage } from './uiLanguage.js'
import type { Opportunity } from './model.js'
import type { ChangeSetRecord } from './changeSet.js'
import './progressInbox.css'

interface ProgressInboxProps {
  onChanged?: () => void
}

const confidenceLabel = {
  high: ['高置信度', 'High confidence'],
  medium: ['需留意', 'Review suggested'],
  low: ['待确认', 'Needs confirmation'],
} as const

export default function ProgressInboxHeavy({ onChanged }: ProgressInboxProps) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [parsedText, setParsedText] = useState<string | null>(null)
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

  function editText(nextText: string) {
    setText(nextText)
    setError('')
    if (plan || parsedText !== null) {
      // A ChangeSet is a proposal for one exact source text. Once the user edits
      // that text, the old preview must not remain confirmable. Keep the pending
      // record reference only so parse()/close() can discard it durably.
      setPlan(null)
      setParsedText(null)
      setMessage(zh
        ? '输入已变化；旧预览已失效，请重新解析。'
        : 'The input changed. The old preview is stale; parse again before applying.')
      return
    }
    setMessage('')
  }

  async function parse() {
    setMessage('')
    setError('')
    if (!text.trim()) {
      setError(zh ? '先输入最近的历程、岗位进展或其他待办。' : 'Enter a recent recruiting update or another task first.')
      return
    }
    setBusy(true)
    try {
      const sourceText = text
      const [current, processEvents, actions, discoveryInbox] = await Promise.all([
        getAllOpportunities(),
        getAllProcessEvents(),
        getAllActionsForMutationBaseline(),
        getAllDiscoveryInboxItems(),
      ])
      setOpportunities(current)
      if (changeSet?.status === 'pending') {
        await discardChangeSet(changeSet.id)
        setChangeSet(null)
      }
      setPlan(null)
      setParsedText(null)

      const canonicalReferences: CanonicalJobReference[] = discoveryInbox
        .filter((item) => item.status !== 'dismissed')
        .map((item) => ({
          opportunityId: item.promotedOpportunityId ?? item.candidateOpportunityId,
          company: item.company,
          role: item.role,
          sourceBacked: true,
          sourceLabel: item.sourceUrl,
        }))

      const nextPlan = parseProgressUpdate(sourceText, current, new Date(), canonicalReferences)
      const canonical = nextPlan.executable.length > 0
        ? createCanonicalProgressChangeSet(nextPlan.executable, processEvents, actions)
        : undefined
      const nextChangeSet = canonical ? await savePendingChangeSet(canonical) : null
      setPlan(nextPlan)
      setChangeSet(nextChangeSet)
      setParsedText(sourceText)
      if (nextPlan.executable.length > 0 && !canonical) {
        setMessage(zh
          ? '识别到的进展已经是当前工作区状态，无需重复写入或生成 ChangeSet。'
          : 'The recognized progress is already reflected in the workspace. No duplicate ChangeSet is needed.')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : (zh ? '无法生成 ChangeSet。' : 'Could not generate a ChangeSet.'))
    } finally {
      setBusy(false)
    }
  }

  async function close() {
    if (changeSet?.status === 'pending') await discardChangeSet(changeSet.id)
    setPlan(null)
    setParsedText(null)
    setChangeSet(null)
    setOpen(false)
  }

  async function confirm() {
    if (!plan || !changeSet || changeSet.operations.length === 0) return
    if (parsedText === null || parsedText !== text) {
      setPlan(null)
      setParsedText(null)
      setError(zh
        ? '输入已变化，旧 ChangeSet 不会应用。请重新解析当前文本。'
        : 'The input changed, so the old ChangeSet will not be applied. Parse the current text again.')
      return
    }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const applied = await applyChangeSet(changeSet.id)
      const notes: string[] = []
      if (plan.unresolved.length > 0) notes.push(zh ? `${plan.unresolved.length} 条歧义未写入` : `${plan.unresolved.length} ambiguous item(s) not written`)
      if (plan.ignored.length > 0) notes.push(zh ? `${plan.ignored.length} 条背景记录无需写入` : `${plan.ignored.length} background item(s) ignored`)
      setMessage(zh
        ? `ChangeSet ${applied.id} 已应用 ${applied.operations.length} 项修改${notes.length ? `；${notes.join('，')}。` : '。'}`
        : `ChangeSet ${applied.id} applied ${applied.operations.length} change(s)${notes.length ? `; ${notes.join('; ')}.` : '.'}`)
      setText('')
      setParsedText(null)
      setPlan(null)
      setChangeSet(null)
      setOpportunities(await getAllOpportunities())
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : (zh ? '更新失败。' : 'Update failed.'))
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
        {zh ? '更新进展 / 事项' : 'Update progress / task'}
      </button>
      {open ? (
        <div className="progress-inbox-backdrop" onMouseDown={() => { void close() }}>
          <section className="progress-inbox-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header className="progress-inbox-header">
              <div>
                <div className="eyebrow">NATURAL LANGUAGE UPDATE</div>
                <h2>{zh ? '把岗位进展和其他事项直接告诉 PJSDAS' : 'Tell PJSDAS about recruiting progress or another task'}</h2>
                <p>{zh
                  ? '岗位输入只作为别名：系统优先使用已有 Opportunity 或官网/来源候选中的统一岗位名，避免少字、简称或错字生成第二个岗位。普通事项会进入普通待办，不会硬套成公司或岗位。'
                  : 'Typed job names are aliases only. PJSDAS prefers canonical names from existing Opportunities or source-backed candidates so abbreviations and typos do not create duplicate jobs. General tasks remain general tasks.'}</p>
              </div>
              <button type="button" className="progress-inbox-close" onClick={() => { void close() }} aria-label={zh ? '关闭' : 'Close'}>×</button>
            </header>

            <textarea
              className="progress-inbox-textarea"
              rows={10}
              value={text}
              disabled={busy}
              onChange={(event) => editText(event.target.value)}
              placeholder={zh
                ? '例如：\n投递小鹏 AI产品经理。\n小鹏测试。\n待办：修改论文图表。\n9月22日，小鹏产品经理10点面试。'
                : 'The natural-language parser currently accepts Chinese recruiting updates, for example:\n投递小鹏 AI产品经理。\n小鹏测试。\n待办：修改论文图表。\n9月22日，小鹏产品经理10点面试。'}
            />

            <div className="progress-inbox-toolbar">
              <small>{zh
                ? '新岗位需要已有岗位或官网/来源候选提供 canonical 名称；手输简称不会直接新建第二个岗位。'
                : 'A new job needs a canonical name backed by an existing job or source candidate. A typed abbreviation cannot silently create a second job.'}</small>
              <button className="primary-button" type="button" onClick={parse} disabled={busy}>{busy ? (zh ? '处理中…' : 'Processing…') : (zh ? '解析并生成 ChangeSet' : 'Parse and generate ChangeSet')}</button>
            </div>

            {error ? <div className="progress-message error">{error}</div> : null}
            {message ? <div className="progress-message success">{message}</div> : null}

            {plan ? (
              <div className="progress-plan">
                <div className="progress-plan-heading">
                  <div>
                    <div className="eyebrow">CHANGESET · {changeSet?.id ?? 'NO WRITABLE CHANGE'}</div>
                    <h3>{zh ? `准备执行 ${changeSet?.operations.length ?? 0} 项修改` : `${changeSet?.operations.length ?? 0} change(s) ready`}</h3>
                  </div>
                  <span>
                    {plan.unresolved.length > 0
                      ? (zh
                          ? `${plan.unresolved.length} 条待确认${plan.ignored.length ? ` · ${plan.ignored.length} 条无需写入` : ''}`
                          : `${plan.unresolved.length} need confirmation${plan.ignored.length ? ` · ${plan.ignored.length} ignored` : ''}`)
                      : plan.ignored.length > 0
                        ? (zh ? `${plan.ignored.length} 条无需写入` : `${plan.ignored.length} ignored`)
                        : changeSet
                          ? (zh ? '可直接确认' : 'Ready to confirm')
                          : (zh ? '状态已是最新' : 'Already up to date')}
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
                          <strong>{progressOperationSummaryForLanguage(operation, lang)}</strong>
                          <p>{operation.sourceText}</p>
                          {operation.kind === 'unresolved' && operation.candidates?.length ? (
                            <small>{zh ? '可能对应：' : 'Possible matches: '}{operation.candidates.map((item) => item.label).join(zh ? '；' : '; ')}</small>
                          ) : operation.kind === 'ignored' ? (
                            <small>{zh ? '已识别为背景记录 · 不修改岗位数据库' : 'Recognized as background context · no workspace mutation'}</small>
                          ) : noOp ? (
                            <small>{zh ? '当前状态已经包含这条进展 · 不重复写入' : 'The workspace already contains this progress · no duplicate write'}</small>
                          ) : canonicalActionCompletion ? (
                            <small>{zh ? '将已有流程 Action 标记为完成 · 不重复创建测评/笔试/面试事件' : 'Complete the existing process Action · do not create a duplicate assessment/test/interview event'}</small>
                          ) : operation.kind === 'manual_action' ? (
                            <small>{zh ? '普通事项 · 不关联公司或岗位' : 'General task · not forced onto a company or role'}</small>
                          ) : (
                            <small>{confidenceLabel[operation.confidence][zh ? 0 : 1]}</small>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>

                {plan.unresolved.length > 0 ? (
                  <div className="progress-message warning">
                    {zh
                      ? '黄色项不会写入，也不会进入 Today。岗位歧义需要已有/官网来源支持的统一岗位名；普通事项可以用“待办：……”明确标记。'
                      : 'Unresolved items are not written and do not enter Today. Ambiguous jobs require a canonical source-backed role; general tasks can be marked explicitly with “待办：…”.'}
                  </div>
                ) : null}

                <div className="progress-confirm-row">
                  <small>{zh
                    ? '确认后只应用上方明确修改；无法安全归类的项保持未写入，不会因为复核占据 Today。'
                    : 'Confirmation applies only the explicit changes above. Items that cannot be classified safely remain unwritten and never occupy Today as review work.'}</small>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={confirm}
                    disabled={busy || !changeSet || changeSet.operations.length === 0}
                  >
                    {busy
                      ? (zh ? '应用中…' : 'Applying…')
                      : changeSet
                        ? (zh ? `确认并应用 ChangeSet · ${changeSet.operations.length} 项` : `Confirm and apply ChangeSet · ${changeSet.operations.length}`)
                        : (zh ? '无需应用' : 'No change to apply')}
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
