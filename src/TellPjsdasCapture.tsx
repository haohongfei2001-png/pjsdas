import { useEffect, useRef, useState } from 'react'
import {
  submitWebSemanticCapture,
  undoWebSemanticChange,
  type LocalSemanticUndoToken,
} from './webSemanticIntake.js'
import { useUiLanguage } from './uiLanguage.js'
import { useCloud } from './cloud/CloudContext.js'
import { ensureAuthoritativePersistence } from './cloud/authoritativePersistence.js'
import { connectedWorkspaceAuthorityEnabled } from './cloud/connectedWorkspaceRepository.js'
import {
  clearAccountDraft,
  readAccountDraft,
  saveAccountDraft,
} from './cloud/authoritativeCommandClient.js'
import './ultimateWeb.css'

interface TellPjsdasCaptureProps {
  open: boolean
  onClose: () => void
  onChanged: () => Promise<void>
  onOpenDecisions: () => void
}

export default function TellPjsdasCapture({
  open,
  onClose,
  onChanged,
  onOpenDecisions,
}: TellPjsdasCaptureProps) {
  const { lang } = useUiLanguage()
  const cloud = useCloud()
  const zh = lang === 'zh'
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [decisionCount, setDecisionCount] = useState(0)
  const [unresolvedCount, setUnresolvedCount] = useState(0)
  const [undo, setUndo] = useState<LocalSemanticUndoToken>()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!open || !cloud.session || !connectedWorkspaceAuthorityEnabled()) return
    setText(readAccountDraft(cloud.session.user.id, 'tell-pjsdas'))
  }, [open, cloud.session?.user.id])

  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => textareaRef.current?.focus(), 0)
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void submit()
      }
    }
    window.addEventListener('keydown', key)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('keydown', key)
    }
  }, [open, text])

  async function submit() {
    if (!text.trim() || busy) return
    setBusy(true)
    setMessage('')
    setError('')
    setDecisionCount(0)
    setUnresolvedCount(0)
    try {
      const result = await submitWebSemanticCapture(text, { accountKey: cloud.session?.user.id })
      if ((result.status === 'APPLIED' || result.status === 'DECISION_REQUIRED') && cloud.session && !connectedWorkspaceAuthorityEnabled()) {
        await ensureAuthoritativePersistence(true, cloud.syncNow)
      }
      setUndo(result.undo)
      setDecisionCount(result.decisionRequestIds.length)
      setUnresolvedCount(result.unresolved.length)
      if (result.status === 'NO_WRITE') {
        setMessage(zh
          ? '这段内容没有被当作当前事实写入。问题、引用、假设和改写请求会保持只读。'
          : 'Nothing was written. Questions, quotes, hypotheticals, and rewrite requests remain read-only.')
      } else if (result.status === 'ALREADY_APPLIED') {
        setMessage(zh ? '这条来源已经处理过，没有重复写入。' : 'This source was already handled; no duplicate write was created.')
      } else {
        const parts = [
          result.status === 'APPLIED' ? (zh ? '已记录明确事实。' : 'Clear facts were recorded.') : '',
          result.decisionRequestIds.length ? (zh ? `${result.decisionRequestIds.length} 项需要你决定。` : `${result.decisionRequestIds.length} item(s) need your decision.`) : '',
          result.unresolved.length ? (zh ? `${result.unresolved.length} 个片段仍不够明确，未写入。` : `${result.unresolved.length} fragment(s) remain ambiguous and were not written.`) : '',
        ].filter(Boolean)
        setMessage(parts.join(' '))
        if (result.status === 'APPLIED') {
          setText('')
          if (cloud.session && connectedWorkspaceAuthorityEnabled()) clearAccountDraft(cloud.session.user.id, 'tell-pjsdas')
        }
        await onChanged()
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
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
      setMessage(zh ? '刚才的写入已撤销。' : 'The last write was undone.')
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="ultimate-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="ultimate-capture-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tell-pjsdas-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ultimate-sheet-header">
          <div>
            <div className="eyebrow">TELL PJSDAS</div>
            <h2 id="tell-pjsdas-title">{zh ? '直接告诉 PJSDAS' : 'Tell PJSDAS directly'}</h2>
            <p>{zh
              ? '说事实、计划或当前决定。明确且安全的内容直接记录；只有真正有歧义的部分才会问你。'
              : 'State a fact, plan, or current decision. Clear safe facts are recorded directly; only genuinely ambiguous parts ask you.'}</p>
          </div>
          <button className="ultimate-icon-button" type="button" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}>×</button>
        </header>

        <textarea
          ref={textareaRef}
          className="ultimate-capture-input"
          rows={6}
          value={text}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value
            setText(value)
            if (cloud.session && connectedWorkspaceAuthorityEnabled()) {
              saveAccountDraft(cloud.session.user.id, 'tell-pjsdas', value)
            }
            setMessage('')
            setError('')
          }}
          placeholder={zh
            ? '例如：京东笔试做完了。\n这个岗位我不投了。\n明天下午准备小鹏面试。'
            : 'For example: 京东笔试做完了。\n这个岗位我不投了。\n明天下午准备小鹏面试。'}
        />

        <div className="ultimate-capture-footer">
          <small>{zh ? '⌘ Enter 提交 · Esc 关闭' : '⌘ Enter to submit · Esc to close'}</small>
          <button className="primary-button" type="button" disabled={busy || !text.trim()} onClick={() => { void submit() }}>
            {busy ? (zh ? '处理中…' : 'Working…') : (zh ? '告诉 PJSDAS' : 'Tell PJSDAS')}
          </button>
        </div>

        {message ? (
          <div className="ultimate-receipt" role="status" aria-live="polite">
            <div>
              <strong>{zh ? 'PJSDAS 已处理' : 'PJSDAS processed it'}</strong>
              <span>{message}</span>
            </div>
            <div className="ultimate-receipt-actions">
              {undo ? <button type="button" onClick={() => { void undoLast() }}>{zh ? '撤销' : 'Undo'}</button> : null}
              {decisionCount > 0 ? <button type="button" onClick={onOpenDecisions}>{zh ? '去决定' : 'Review decisions'}</button> : null}
            </div>
          </div>
        ) : null}

        {unresolvedCount > 0 && !decisionCount ? (
          <p className="ultimate-capture-hint">{zh
            ? '没有足够证据的片段不会进入 Today，也不会猜测目标。可以补充公司、岗位或具体是哪一次笔试/面试。'
            : 'Fragments without enough evidence do not enter Today and never guess a target. Add the company, role, or exact test/interview occurrence.'}</p>
        ) : null}
        {error ? <div className="ultimate-inline-error" role="alert">{error}</div> : null}
      </section>
    </div>
  )
}
