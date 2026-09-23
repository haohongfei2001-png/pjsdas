import { useEffect, useRef, useState } from 'react'
import {
  previewWebSemanticCapture,
  submitWebSemanticCapture,
  undoWebSemanticChange,
  type LocalSemanticUndoToken,
  type WebSemanticCapturePreview,
} from './webSemanticIntake.js'
import { useUiLanguage } from './uiLanguage.js'
import { useCloud } from './cloud/CloudContext.js'
import { ensureAuthoritativePersistence } from './cloud/authoritativePersistence.js'
import { connectedWorkspaceAuthorityEnabled } from './cloud/connectedWorkspaceRepository.js'
import {
  clearAccountDraft,
  createConnectedCommandId,
  discardAccountPendingOperation,
  findAccountPendingSemanticOperation,
  readAccountDraft,
  saveAccountDraft,
} from './cloud/authoritativeCommandClient.js'
import type { SemanticCandidate } from './model.js'
import './capture/capture.css'

interface TellPjsdasCaptureProps {
  open: boolean
  onClose: () => void
  onChanged: () => Promise<void>
  onOpenDecisions: () => void
  contextLabel?: string
  contextRefs?: string[]
}

type CaptureSaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'unknown' | 'reauth' | 'conflict' | 'error'

function targetLabel(candidate: SemanticCandidate) {
  const target = candidate.target
  if (!target) return ''
  return [target.company, target.role].filter(Boolean).join(' · ')
}

function candidateLabel(candidate: SemanticCandidate, zh: boolean) {
  const target = targetLabel(candidate)
  const suffix = target ? ` · ${target}` : ''
  if (candidate.kind === 'application_submitted') return (zh ? '记录已投递' : 'Record application submitted') + suffix
  if (candidate.kind === 'abandon_opportunity') return (zh ? '停止继续该机会' : 'Stop pursuing opportunity') + suffix
  if (candidate.kind === 'occurrence_completed') {
    const kind = candidate.target?.occurrenceKind
    const label = kind === 'interview' ? (zh ? '面试已完成' : 'Interview completed')
      : kind === 'written_test' ? (zh ? '笔试已完成' : 'Written test completed')
        : kind === 'assessment' ? (zh ? '测评已完成' : 'Assessment completed')
          : (zh ? '招聘节点已完成' : 'Recruiting event completed')
    return label + suffix
  }
  if (candidate.kind === 'occurrence_cancelled') return (zh ? '取消招聘节点' : 'Cancel recruiting event') + suffix
  if (candidate.kind === 'occurrence_rescheduled') return (zh ? '更新招聘时间' : 'Reschedule recruiting event') + suffix
  if (candidate.kind === 'opportunity_deadline') return `${zh ? '更新申请截止' : 'Update deadline'} · ${candidate.deadline}${suffix}`
  if (candidate.kind === 'manual_action') return `${zh ? '新增行动' : 'Add action'} · ${candidate.title}`
  if (candidate.kind === 'process_event') {
    const labels: Record<string, [string, string]> = {
      assessment_invite: ['记录测评安排', 'Record assessment'],
      written_test_invite: ['记录笔试安排', 'Record written test'],
      interview_invite: ['记录面试安排', 'Record interview'],
      offer: ['记录 Offer', 'Record offer'],
      rejection: ['记录流程结果', 'Record process result'],
      status_update: ['更新流程状态', 'Update process status'],
      other: ['记录流程变化', 'Record process update'],
    }
    return (labels[candidate.eventType]?.[zh ? 0 : 1] ?? (zh ? '记录流程变化' : 'Record process update')) + suffix
  }
  if (candidate.kind === 'reminder_intent') return (zh ? '建立提醒意图' : 'Create reminder intent') + suffix
  if (candidate.kind === 'reminder_cancelled') return (zh ? '取消提醒意图' : 'Cancel reminder intent') + suffix
  return (zh ? '识别为外部后果请求' : 'Recognized external consequence request') + suffix
}

function modeExplanation(preview: WebSemanticCapturePreview, zh: boolean) {
  if (preview.mode === 'assertion' || preview.mode === 'current_intent') return undefined
  const labels: Record<string, [string, string]> = {
    question: ['这是问题，不会写入事实。', 'This is a question, so it will not be written as fact.'],
    quote: ['这是引用，不会写入事实。', 'This is quoted material, so it will not be written as fact.'],
    example: ['这是示例，不会写入事实。', 'This is an example, so it will not be written as fact.'],
    hypothetical: ['这是假设，不会写入事实。', 'This is hypothetical, so it will not be written as fact.'],
    rewrite_request: ['这是改写请求，不会写入事实。', 'This is a rewrite request, so it will not be written as fact.'],
  }
  return labels[preview.mode]?.[zh ? 0 : 1]
}

function saveErrorCopy(state: CaptureSaveState, zh: boolean) {
  if (state === 'unknown') return zh
    ? '可能已经保存。请先点“确认保存状态”；确认前不要重复提交。'
    : 'This may already be saved. Check the save status before submitting again.'
  if (state === 'reauth') return zh
    ? '重新登录后点“重新确认”，PJSDAS 会先核对原操作的结果。'
    : 'Sign in again, then retry confirmation. PJSDAS will check the original operation first.'
  if (state === 'conflict') return zh
    ? '请先核对最新事实，再决定是否重新提交。输入内容仍在这里。'
    : 'Review the latest facts before submitting again. Your input remains here.'
  return zh
    ? '输入内容仍在这里。请检查连接后重试。'
    : 'Your input remains here. Check the connection and try again.'
}

export default function TellPjsdasCapture({
  open,
  onClose,
  onChanged,
  onOpenDecisions,
  contextLabel,
  contextRefs = [],
}: TellPjsdasCaptureProps) {
  const { lang } = useUiLanguage()
  const cloud = useCloud()
  const zh = lang === 'zh'
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [preview, setPreview] = useState<WebSemanticCapturePreview>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [saveState, setSaveState] = useState<CaptureSaveState>('idle')
  const [authoritativeSaveConfirmed, setAuthoritativeSaveConfirmed] = useState(false)
  const [decisionCount, setDecisionCount] = useState(0)
  const [unresolvedCount, setUnresolvedCount] = useState(0)
  const [undo, setUndo] = useState<LocalSemanticUndoToken>()
  const [stableCommandId, setStableCommandId] = useState<string>()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const sheetRef = useRef<HTMLElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  const connected = Boolean(cloud.session && connectedWorkspaceAuthorityEnabled())
  const recoveryLocked = saveState === 'unknown' || saveState === 'reauth'

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const initial = cloud.session && connectedWorkspaceAuthorityEnabled()
      ? readAccountDraft(cloud.session.user.id, 'tell-pjsdas')
      : ''
    const resumable = cloud.session && connectedWorkspaceAuthorityEnabled() && initial
      ? findAccountPendingSemanticOperation(cloud.session.user.id, initial)
      : undefined
    setText(initial)
    setPreview(undefined)
    setMessage('')
    setError(resumable?.lastError ?? '')
    setSaveState(resumable?.status === 'unknown' ? 'unknown' : resumable?.status === 'conflict' ? 'conflict' : resumable ? 'reauth' : 'idle')
    setAuthoritativeSaveConfirmed(false)
    setDecisionCount(0)
    setUnresolvedCount(0)
    setUndo(undefined)
    setStableCommandId(resumable?.commandId)
    const id = window.setTimeout(() => textareaRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(id)
      openerRef.current?.focus()
    }
  }, [open, cloud.session?.user.id])

  useEffect(() => {
    if (!open || !text.trim() || busy) {
      setPreviewBusy(false)
      if (!text.trim()) setPreview(undefined)
      return
    }
    let active = true
    setPreviewBusy(true)
    const id = window.setTimeout(() => {
      void previewWebSemanticCapture(text)
        .then((next) => {
          if (!active) return
          setPreview(next)
        })
        .catch((caught) => {
          if (!active) return
          setError(caught instanceof Error ? caught.message : String(caught))
        })
        .finally(() => {
          if (active) setPreviewBusy(false)
        })
    }, 180)
    return () => {
      active = false
      window.clearTimeout(id)
    }
  }, [open, text, busy])

  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void submit()
        return
      }
      if (event.key !== 'Tab' || !sheetRef.current) return
      const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )]
      if (!focusable.length) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open, text, busy, stableCommandId, saveState])

  async function submit() {
    if (!text.trim() || busy) return
    if (connected && typeof navigator !== 'undefined' && !navigator.onLine) {
      saveAccountDraft(cloud.session!.user.id, 'tell-pjsdas', text)
      setSaveState('offline')
      setError('')
      setMessage(zh
        ? '当前离线。内容只保存在这个账号的本机草稿中，还没有写入 PJSDAS。'
        : 'You are offline. This is saved only as this account\'s local draft and has not been written to PJSDAS.')
      return
    }

    const commandId = connected
      ? stableCommandId ?? createConnectedCommandId('web-semantic')
      : undefined
    if (commandId) setStableCommandId(commandId)
    setBusy(true)
    setSaveState('saving')
    setMessage('')
    setError('')
    setDecisionCount(0)
    setUnresolvedCount(0)
    try {
      const result = await submitWebSemanticCapture(text, {
        accountKey: cloud.session?.user.id,
        commandId,
        contextRefs,
        confirmExisting: recoveryLocked,
      })
      if ((result.status === 'APPLIED' || result.status === 'DECISION_REQUIRED') && cloud.session && !connectedWorkspaceAuthorityEnabled()) {
        await ensureAuthoritativePersistence(true, cloud.syncNow)
      }
      setUndo(result.undo)
      setDecisionCount(result.decisionRequestIds.length)
      setUnresolvedCount(result.unresolved.length)
      setSaveState('saved')
      setAuthoritativeSaveConfirmed(result.status === 'APPLIED' || result.status === 'ALREADY_APPLIED')
      setStableCommandId(undefined)
      if (result.status === 'NO_WRITE') {
        setMessage(zh
          ? '没有被当作当前事实写入：这段内容是问题、引用，或缺少可确认事实。'
          : 'Nothing was written: this was read-only, a question/quote, or did not contain a confirmable fact.')
      } else if (result.status === 'ALREADY_APPLIED') {
        setMessage(zh ? '服务器确认这条来源已经处理过，没有重复写入。' : 'The server confirmed this source was already handled; no duplicate was created.')
      } else {
        const summary = /^\d+ bounded update\(s\) committed\.$/.test(result.summary.trim())
          ? (zh ? '已记录明确事实。' : 'Confirmed facts recorded.')
          : result.summary
        const parts = [
          summary,
          result.decisionRequestIds.length ? (zh ? `${result.decisionRequestIds.length} 项需要你决定。` : `${result.decisionRequestIds.length} item(s) need your decision.`) : '',
          result.unresolved.length ? (zh ? `${result.unresolved.length} 个片段仍不够明确，未写入。` : `${result.unresolved.length} fragment(s) remain ambiguous and were not written.`) : '',
          result.ignored.length ? (zh ? `${result.ignored.length} 个片段未作为当前事实处理。` : `${result.ignored.length} fragment(s) were not treated as current facts.`) : '',
        ].filter(Boolean)
        setMessage(parts.join(' '))
        if (result.status === 'APPLIED') {
          setText('')
          setPreview(undefined)
          if (cloud.session && connectedWorkspaceAuthorityEnabled()) clearAccountDraft(cloud.session.user.id, 'tell-pjsdas')
        }
        await onChanged()
      }
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught)
      setError(detail)
      if (/UNKNOWN_COMMAND_OUTCOME/.test(detail)) setSaveState('unknown')
      else if (/SESSION_EXPIRED_BEFORE_COMMAND/.test(detail)) setSaveState('reauth')
      else if (/CONFLICT|conflict/i.test(detail)) setSaveState('conflict')
      else setSaveState('error')
    } finally {
      setBusy(false)
    }
  }

  async function undoLast() {
    if (!undo || busy) return
    setBusy(true)
    setError('')
    try {
      await undoWebSemanticChange(undo)
      if (cloud.session && !connectedWorkspaceAuthorityEnabled()) await ensureAuthoritativePersistence(true, cloud.syncNow)
      setUndo(undefined)
      setSaveState('saved')
      setAuthoritativeSaveConfirmed(false)
      setMessage(zh ? '刚才的权威写入已撤销；其他后续更新保持不变。' : 'The authoritative write was undone; unrelated later updates remain intact.')
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSaveState('conflict')
    } finally {
      setBusy(false)
    }
  }

  function editText(value: string) {
    if (saveState === 'conflict' && stableCommandId && cloud.session) {
      discardAccountPendingOperation(cloud.session.user.id, stableCommandId)
      setStableCommandId(undefined)
    }
    setText(value)
    if (cloud.session && connectedWorkspaceAuthorityEnabled()) {
      saveAccountDraft(cloud.session.user.id, 'tell-pjsdas', value)
    }
    setMessage('')
    setError('')
    setUndo(undefined)
    setAuthoritativeSaveConfirmed(false)
    if (!recoveryLocked) setSaveState('idle')
  }

  if (!open) return null

  const modeNote = preview ? modeExplanation(preview, zh) : undefined

  return (
    <div className="cgr-capture-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={sheetRef}
        className="cgr-capture-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tell-pjsdas-title"
        aria-describedby="tell-pjsdas-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="cgr-capture-header">
          <div>
            <div className="cgr-kicker">TELL PJSDAS</div>
            <h2 id="tell-pjsdas-title">{zh ? '告诉 PJSDAS' : 'Tell PJSDAS'}</h2>
            <p id="tell-pjsdas-description">{zh
              ? '先告诉你 PJSDAS 理解成了什么，再进行权威保存。真正不明确的部分不会猜。'
              : 'PJSDAS shows what it understood before authoritative save. Genuinely ambiguous parts are never guessed.'}</p>
            {contextLabel ? <span className="cgr-capture-context">{zh ? '当前上下文：' : 'Context: '}{contextLabel}</span> : null}
          </div>
          <button className="cgr-icon-button" type="button" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}>×</button>
        </header>

        <textarea
          ref={textareaRef}
          className="cgr-capture-input"
          aria-label={zh ? '要告诉 PJSDAS 的内容' : 'What to tell PJSDAS'}
          rows={5}
          value={text}
          disabled={busy || recoveryLocked}
          onChange={(event) => editText(event.target.value)}
          placeholder={zh
            ? '例如：京东笔试做完了。\n这个岗位我不投了。\n明天下午准备小鹏面试。'
            : 'For example: 京东笔试做完了。\n这个岗位我不投了。\n明天下午准备小鹏面试。'}
        />

        {text.trim() ? (
          <section className="cgr-understanding" aria-live="polite" aria-busy={previewBusy}>
            <div className="cgr-understanding-head">
              <strong>{previewBusy ? (zh ? '正在理解…' : 'Understanding…') : (zh ? 'PJSDAS 理解为' : 'PJSDAS understands')}</strong>
              <span data-state={saveState}>
                {saveState === 'saving' ? (zh ? '正在保存' : 'Saving')
                  : saveState === 'saved' ? (zh ? '已保存' : 'Saved')
                    : saveState === 'unknown' ? (zh ? '等待确认' : 'Confirming')
                      : saveState === 'offline' ? (zh ? '仅草稿' : 'Draft only')
                        : (zh ? '尚未保存' : 'Not saved')}
              </span>
            </div>
            {!previewBusy && preview ? (
              <div className="cgr-understanding-body">
                {modeNote ? <p className="cgr-understanding-note">{modeNote}</p> : null}
                {preview.candidates.length ? (
                  <ul>
                    {preview.candidates.map((candidate) => <li key={candidate.id}>{candidateLabel(candidate, zh)}</li>)}
                  </ul>
                ) : !modeNote ? (
                  <p className="cgr-understanding-note">{zh ? '暂时没有足够明确、可写入的事实。' : 'No sufficiently clear writable fact has been identified yet.'}</p>
                ) : null}
                {preview.unresolved.length ? (
                  <p className="cgr-understanding-warning">{zh ? `${preview.unresolved.length} 个片段仍需更明确的公司、岗位或招聘节点。` : `${preview.unresolved.length} fragment(s) still need a clearer company, role, or recruiting event.`}</p>
                ) : null}
                {preview.ignored.length ? (
                  <p className="cgr-understanding-note">{zh ? `${preview.ignored.length} 个片段未作为当前事实处理（如引用的旧消息）。` : `${preview.ignored.length} fragment(s) were not treated as current facts (such as quoted history).`}</p>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        <div className="cgr-capture-footer">
          <small>{zh ? '⌘ Enter 提交 · Esc 关闭' : '⌘ Enter to submit · Esc to close'}</small>
          <button className="cgr-primary-button" type="button" disabled={busy || !text.trim()} onClick={() => { void submit() }}>
            {busy ? (zh ? '正在权威保存…' : 'Saving authoritatively…')
              : saveState === 'unknown' ? (zh ? '确认保存状态' : 'Confirm save status')
                : saveState === 'reauth' ? (zh ? '重新确认' : 'Retry confirmation')
                  : (zh ? '确认并保存' : 'Confirm and save')}
          </button>
        </div>

        {message ? (
          <div className={`cgr-capture-receipt state-${saveState}`} role="status" aria-live="polite">
            <div>
              <strong>{saveState === 'offline' ? (zh ? '尚未写入' : 'Not written yet')
                : authoritativeSaveConfirmed && !text.trim() ? (zh ? '已保存' : 'Saved')
                  : (zh ? '处理结果' : 'Result')}</strong>
              <span>{message}</span>
            </div>
            <div className="cgr-capture-receipt-actions">
              {undo ? <button type="button" onClick={() => { void undoLast() }}>{zh ? '撤销' : 'Undo'}</button> : null}
              {decisionCount > 0 ? <button type="button" onClick={onOpenDecisions}>{zh ? '去决定' : 'Review decisions'}</button> : null}
            </div>
          </div>
        ) : null}

        {unresolvedCount > 0 && !decisionCount ? (
          <p className="cgr-capture-hint">{zh
            ? '没有足够证据的片段不会进入 Today。补充公司、岗位或具体是哪一次笔试/面试即可。'
            : 'Fragments without enough evidence do not enter Today. Add the company, role, or exact test/interview occurrence.'}</p>
        ) : null}
        {error ? (
          <div className={`cgr-capture-error state-${saveState}`} role="alert">
            <strong>{saveState === 'unknown'
              ? (zh ? '保存结果暂时未知' : 'Save outcome is not confirmed yet')
              : saveState === 'reauth'
                ? (zh ? '登录会话已过期' : 'Session expired')
                : saveState === 'conflict'
                  ? (zh ? '发现具体事实冲突' : 'A concrete fact conflict was found')
                  : (zh ? '没有完成保存' : 'Save did not complete')}</strong>
            <span>{saveErrorCopy(saveState, zh)}</span>
          </div>
        ) : null}
      </section>
    </div>
  )
}
