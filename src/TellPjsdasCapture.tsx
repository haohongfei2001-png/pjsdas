import { aiCandidateDetails } from './capture/aiCandidateDetails.js'
import { aiCaptureEnabled, previewAiCapture, confirmAiCapture, isCurrentAiPreview, type AiCapturePreview } from './aiCaptureClient.js'
import { createCapturePreviewPresentation, canRetainRecoveryPreview } from './capturePreviewPresentation.js'
import ManualJobFields from './capture/ManualJobFields.js'
import { readCaptureTextFile, appendCaptureQuote, CaptureTextFileError } from './capture/textFile.js'
import { capturePopoverLayout } from './capture/popoverLayout.js'
import { captureFocusIsVacant, createCaptureOperationLifecycle } from './capture/operationLifecycle.js'
import { manualJobDraft, readManualJobDraft, manualJobCandidate } from './capture/manualJob.js'
import type { UserJobFacts } from './opportunityCreation.js'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
const RecordCorrectionReview = lazy(() => import('./RecordCorrectionReview.js'))
import {
  previewWebSemanticCapture,
  submitWebSemanticCapture,
  undoWebSemanticChange,
  type LocalSemanticUndoToken,
  type WebSemanticCapturePreview,
} from './webSemanticIntake.js'
import { useUiLanguage } from './uiLanguage.js'
import { useCloud } from './cloud/CloudContext.js'
import { WorkspaceWriteAuthError } from './cloud/workspaceWriteLease.js'
import { ensureAuthoritativePersistence } from './cloud/authoritativePersistence.js'
import { connectedWorkspaceAuthorityEnabled } from './cloud/connectedWorkspaceRepository.js'
import {
  clearAccountDraft,
  createConnectedCommandId,
  discardAccountPendingOperation,
  findAccountPendingSemanticOperation,
  readAccountDraft,
  saveAccountDraft,
  UnknownCommandOutcomeError,
  ConnectedProjectionPendingError,
  CommandBlockedByPendingProjectionError,
  PreExecutionCommandError,
} from './cloud/authoritativeCommandClient.js'
import type { SemanticCandidate } from './model.js'
import { captureSessionTransition } from './captureSession.js'
import './capture/capture.css'

interface TellPjsdasCaptureProps {
  open: boolean
  onClose: (restoreFocus?: boolean) => void
  anchorRef?: RefObject<HTMLButtonElement | null>
  onChanged: () => Promise<void>
  onOpenDecisions: () => void
  contextLabel?: string
  contextRefs?: string[]
}

type CaptureSaveState = 'ai_preview_error' | 'idle' | 'saving' | 'saved' | 'offline' | 'unknown' | 'reauth' | 'conflict' | 'error' | 'confirmed_pending' | 'blocked_by_pending' | 'auth_unconfirmed'

function targetLabel(candidate: SemanticCandidate) {
  const target = candidate.target
  if (!target) return ''
  return [target.company, target.role].filter(Boolean).join(' · ')
}

function candidateLabel(candidate: SemanticCandidate, zh: boolean) {
  const target = targetLabel(candidate)
  const suffix = target ? ` · ${target}` : ''
  if (candidate.kind === 'user_opportunity') return `${zh ? '添加岗位' : 'Add job'} · ${candidate.company} · ${candidate.role}`
  if (candidate.kind === 'application_action') return (zh ? '安排投递任务' : 'Plan application') + suffix
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
  if (state === 'ai_preview_error') return zh
    ? '没有生成可确认的 AI 预览，也没有保存任何内容。输入仍保留，可点击箭头重试。'
    : 'No reviewable AI preview was generated and nothing was saved. Your input is retained; click the arrow to retry.'
  if (state === 'auth_unconfirmed') return zh
    ? '内容尚未保存。请等待账号恢复后重试；若一直无法恢复，请到设置重新连接。'
    : 'Nothing was saved. Retry after your account recovers, or reconnect in Settings if it stays unavailable.'
  if (state === 'unknown') return zh
    ? '可能已经保存。请先点“确认保存状态”；确认前不要重复提交。'
    : 'This may already be saved. Check the save status before submitting again.'
  if (state === 'reauth') return zh
    ? '重新登录后点“重新确认”，TodayAction 会先核对原操作的结果。'
    : 'Sign in again, then retry confirmation. TodayAction will check the original operation first.'
  if (state === 'confirmed_pending') return zh
    ? '服务器已确认这次操作。请在设置中核对本机状态，再确认保存结果；原操作不会重复发送。'
    : 'The server confirmed this action. Review this device in Settings, then confirm the saved result; the original action will not be resent.'
  if (state === 'blocked_by_pending') return zh
    ? '此前已确认的操作仍待本机安全刷新；这次新操作没有发送。输入仍保留，先在设置中核对同步状态。'
    : 'An earlier confirmed action awaits a safe refresh. This new action was not sent. Your input is retained; review sync in Settings.'
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
  anchorRef,
  onChanged,
  onOpenDecisions,
  contextLabel,
  contextRefs = [],
}: TellPjsdasCaptureProps) {
  const { lang } = useUiLanguage()
  const cloud = useCloud()
  const zh = lang === 'zh'
  const [manualMode, setManualMode] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const naturalDraftRef = useRef('')
  const manualDraftRef = useRef<UserJobFacts>({ company: '', role: '' })
  const [correctionMode, setCorrectionMode] = useState(false)
  useEffect(() => { if (!open) setCorrectionMode(false) }, [open])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewRequest, setPreviewRequest] = useState(0)
  const [aiRequest, setAiRequest] = useState<{ text: string; accountKey: string; requestId: string }>()
  const processedAiRequest = useRef<string | undefined>(undefined)
  const [fileReading, setFileReading] = useState(false)
  const [fileAttachment, setFileAttachment] = useState<{ name: string; quote: string }>()
  const [fileNotice, setFileNotice] = useState('')
  const [fileError, setFileError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const fileTriggerRef = useRef<HTMLButtonElement | null>(null)
  const previewSectionRef = useRef<HTMLElement | null>(null)
  const fileReadEpochRef = useRef(0)
  const [storedPreview, setPreview] = useState<WebSemanticCapturePreview>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [saveState, setSaveState] = useState<CaptureSaveState>('idle')
  const [authoritativeSaveConfirmed, setAuthoritativeSaveConfirmed] = useState(false)
  const [decisionCount, setDecisionCount] = useState(0)
  const [unresolvedCount, setUnresolvedCount] = useState(0)
  const [undo, setUndo] = useState<LocalSemanticUndoToken>()
  const [stableCommandId, setStableCommandId] = useState<string>()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const correctionBackRef = useRef<HTMLButtonElement | null>(null)
  const sheetRef = useRef<HTMLElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const restoreFocusRef = useRef(true)
  const closedDraftRef = useRef<{ accountKey: string | null; text: string } | undefined>(undefined)
  const [popoverStyle, setPopoverStyle] = useState<ReturnType<typeof capturePopoverLayout>>()
  const initializedUserIdRef = useRef<string | null | undefined>(undefined)
  const textRef = useRef('')
  const operationLifecycle = useRef(createCaptureOperationLifecycle())
  const accountKey = cloud.session?.user.id ?? null

  useLayoutEffect(() => {
    operationLifecycle.current.updateView(open, accountKey)
    setBusy(false)
    if (saveState === 'saving') {
      // Account jitter can preserve the draft without reinitializing the view.
      // Keep its command identity recoverable, never an abandoned Saving label.
      setSaveState(stableCommandId ? 'unknown' : 'idle')
      setError(stableCommandId ? saveErrorCopy('unknown', zh) : '')
      setUndo(undefined)
      setMessage('')
      setAuthoritativeSaveConfirmed(false)
      setDecisionCount(0)
      setUnresolvedCount(0)
    }
  }, [open, accountKey])
  useLayoutEffect(() => {
    if (!busy) operationLifecycle.current.restoreFocus(textareaRef.current
      ?? sheetRef.current?.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled)'))
  })
  useLayoutEffect(() => () => operationLifecycle.current.invalidate(), [])

  const connected = Boolean(cloud.session && connectedWorkspaceAuthorityEnabled())
  const modelCapture = aiCaptureEnabled() && !manualMode
  const currentAiPreview = isCurrentAiPreview(storedPreview, text, accountKey) ? storedPreview : undefined
  const preview = modelCapture ? currentAiPreview : storedPreview && 'ai' in storedPreview ? undefined : storedPreview
  const recoveryLocked = saveState === 'unknown' || saveState === 'reauth' || saveState === 'confirmed_pending' || saveState === 'offline'

  const previewPresentation = useRef(createCapturePreviewPresentation())
  const previewIdentity = useRef<unknown[]>([])
  const settledPreviewIdentity = useRef<readonly unknown[] | undefined>(undefined)
  const fileReadIdentity = useRef<unknown[]>([])
  const inputIdentity = [open, text, manualMode, correctionMode, busy, cloud.session, recoveryLocked]
  if (inputIdentity.some((value, index) => value !== fileReadIdentity.current[index])) {
    fileReadEpochRef.current += 1
    fileReadIdentity.current = inputIdentity
  }
  const parsedIdentity = [open, text, manualMode, correctionMode, cloud.session, previewRequest]
  if (settledPreviewIdentity.current && parsedIdentity.some((value, index) => value !== settledPreviewIdentity.current![index])) settledPreviewIdentity.current = undefined
  const identity = [...inputIdentity, previewRequest]
  if (identity.some((value, index) => value !== previewIdentity.current[index])) {
    previewPresentation.current.invalidate()
    previewIdentity.current = identity
    if (!open || correctionMode) previewPresentation.current.reset()
  }

  useEffect(() => { setFileReading(false); setFileAttachment(undefined); setFileNotice(''); setFileError('') }, [open, manualMode, correctionMode, cloud.session])
  useEffect(() => { setFileReading(false) }, [text, busy, recoveryLocked])

  useEffect(() => {
    if (!open) {
      if (initializedUserIdRef.current === null && !cloud.session?.user.id) closedDraftRef.current = { accountKey: null, text: textRef.current }
      initializedUserIdRef.current = undefined
      setMoreOpen(false)
      return
    }
    restoreFocusRef.current = true
    openerRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : anchorRef?.current ?? null
    const sheet = sheetRef.current
    const id = window.setTimeout(() => { if (restoreFocusRef.current) textareaRef.current?.focus({ preventScroll: true }) }, 0)
    return () => {
      window.clearTimeout(id)
      if (restoreFocusRef.current && (captureFocusIsVacant(document) || sheet?.contains(document.activeElement))) openerRef.current?.focus({ preventScroll: true })
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const viewport = window.visualViewport
      setPopoverStyle(capturePopoverLayout(anchorRef?.current?.getBoundingClientRect(), {
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
      }))
    }
    place()
    const observer = new ResizeObserver(place)
    if (anchorRef?.current) observer.observe(anchorRef.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [open, anchorRef])

  useLayoutEffect(() => {
    const input = textareaRef.current
    if (!open || !input) return
    const fit = () => {
      input.style.height = '0px'
      input.style.height = `${Math.min(160, Math.max(44, input.scrollHeight))}px`
    }
    fit()
    const observer = new MutationObserver(fit)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'lang'] })
    return () => observer.disconnect()
  }, [open, text, manualMode, correctionMode, popoverStyle?.width])

  function dismissCapture(restoreFocus = true) {
    closedDraftRef.current = initializedUserIdRef.current === null && !cloud.session?.user.id ? { accountKey: null, text: textRef.current } : undefined
    restoreFocusRef.current = restoreFocus
    operationLifecycle.current.invalidate()
    onClose(restoreFocus)
  }

  useEffect(() => {
    if (!open) return
    const trackFocusOwnership = (event: Event) => {
      if (!(event.target instanceof Node)) return
      if (sheetRef.current?.contains(event.target)) { restoreFocusRef.current = true; return }
      restoreFocusRef.current = false
      operationLifecycle.current.releaseFocus()
    }
    const outside = (event: PointerEvent) => {
      trackFocusOwnership(event)
      const target = event.target
      if (!(target instanceof Node) || sheetRef.current?.contains(target) || anchorRef?.current?.contains(target)) return
      dismissCapture(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', trackFocusOwnership, true)
    document.addEventListener('click', trackFocusOwnership, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', trackFocusOwnership, true)
      document.removeEventListener('click', trackFocusOwnership, true)
    }
  }, [open, cloud.session?.user.id, onClose, anchorRef])

  useEffect(() => {
    if (!open) return
    // Run after capturing the opener. The secondary trigger unmounts in review
    // mode; keep focus in the dialog and restore the preserved natural draft.
    if (correctionMode) correctionBackRef.current?.focus()
    else if (!manualMode) textareaRef.current?.focus()
  }, [open, correctionMode, manualMode])

  useEffect(() => {
    if (!open) return
    const userId = cloud.session?.user.id
    const transition = captureSessionTransition(
      initializedUserIdRef.current,
      userId,
      Boolean(textRef.current.trim()),
    )
    if (transition === 'ignore') return
    initializedUserIdRef.current = userId ?? null
    if (transition === 'adopt') {
      if (userId && connectedWorkspaceAuthorityEnabled()) {
        saveAccountDraft(userId, 'tell-pjsdas', textRef.current)
      }
      return
    }
    const retainedDraft = closedDraftRef.current?.accountKey === (userId ?? null) ? closedDraftRef.current.text : ''
    const initial = userId && connectedWorkspaceAuthorityEnabled()
      ? readAccountDraft(userId, 'tell-pjsdas')
      : retainedDraft
    const resumable = userId && connectedWorkspaceAuthorityEnabled() && initial
      ? findAccountPendingSemanticOperation(userId, initial)
      : undefined
    textRef.current = initial
    const manual = readManualJobDraft(initial)
    setManualMode(Boolean(manual))
    manualDraftRef.current = manual ?? { company: '', role: '' }
    naturalDraftRef.current = manual ? '' : initial
    setText(initial)
    setPreview(undefined)
    setMessage('')
    setError(resumable?.lastError ?? '')
    setSaveState(resumable?.status === 'pending' ? 'offline'
      : resumable?.status === 'unknown' ? 'unknown'
      : resumable?.status === 'projection_pending' ? 'confirmed_pending'
        : resumable?.status === 'conflict' ? 'conflict' : resumable ? 'reauth' : 'idle')
    setAuthoritativeSaveConfirmed(false)
    setDecisionCount(0)
    setUnresolvedCount(0)
    setUndo(undefined)
    setStableCommandId(resumable?.commandId)
  }, [open, cloud.session?.user.id])

  useEffect(() => {
    if (!open || saveState !== 'offline' || !stableCommandId || !cloud.session) return
    const accountKey = cloud.session.user.id
    const settled = (event: Event) => {
      const detail = (event as CustomEvent<{ commandId: string; outcome: string; localProjection?: string; resultStatus?: string; decisionRequestIds?: unknown }>).detail
      if (detail.commandId !== stableCommandId) return
      if (detail.outcome === 'CONFLICT') {
        setSaveState('conflict')
        setMessage(zh ? '这项操作与较新的事实冲突，请核对后处理。' : 'This action conflicts with a newer fact. Review it before proceeding.')
        return
      }
      if (detail.localProjection !== 'applied') return
      setStableCommandId(undefined)
      setSaveState('saved')
      if (detail.resultStatus === 'APPLIED' || detail.resultStatus === 'ALREADY_APPLIED') {
        if (readAccountDraft(accountKey, 'tell-pjsdas') === textRef.current) clearAccountDraft(accountKey, 'tell-pjsdas')
        textRef.current = ''
        setText('')
        setPreview(undefined)
        setAuthoritativeSaveConfirmed(true)
        setMessage(zh ? '已自动保存。' : 'Saved automatically.')
      } else if (detail.resultStatus === 'DECISION_REQUIRED') {
        const count = Array.isArray(detail.decisionRequestIds) ? detail.decisionRequestIds.length : 0
        setDecisionCount(count)
        setAuthoritativeSaveConfirmed(false)
        setMessage(zh ? '已记录待确认的业务问题。' : 'A business question is ready for your decision.')
      } else {
        setAuthoritativeSaveConfirmed(false)
        setMessage(zh ? '已核对，未写入新的事实。' : 'Checked; no new fact was written.')
      }
    }
    window.addEventListener('pjsdas:command-recovered', settled)
    return () => window.removeEventListener('pjsdas:command-recovered', settled)
  }, [open, saveState, stableCommandId, cloud.session?.user.id, zh])

  useEffect(() => {
    if (!open || manualMode || correctionMode || !text.trim() || busy) {
      setPreviewBusy(false)
      if (!text.trim()) setPreview(undefined)
      return
    }
    // A queued/uncertain command locks this exact input. Keep its settled
    // preview instead of starting another layout-changing parse under Save.
    if (canRetainRecoveryPreview(recoveryLocked, parsedIdentity, settledPreviewIdentity.current)) {
      setPreviewBusy(false)
      return
    }
    if (modelCapture && (!connected || !aiRequest || aiRequest.text !== text || aiRequest.accountKey !== accountKey)) {
      setPreview(undefined)
      setPreviewBusy(false)
      return
    }
    if (modelCapture && processedAiRequest.current === aiRequest?.requestId) { setPreviewBusy(false); return }
    const presentation = previewPresentation.current.begin()
    setPreviewBusy(true)
    const id = window.setTimeout(() => {
      if (modelCapture) processedAiRequest.current = aiRequest!.requestId
      void (modelCapture ? previewAiCapture(text, accountKey!, aiRequest!.requestId) : previewWebSemanticCapture(text))
        .then((next) => {
          presentation.publish(() => { settledPreviewIdentity.current = parsedIdentity; setPreview(next); setPreviewBusy(false) })
        })
        .catch((caught) => {
          presentation.publish(() => {
            const failure = caught instanceof Error ? caught.message : String(caught)
            setError(failure)
            if (modelCapture) setSaveState('ai_preview_error')
            // Only a known stale/expired result permits a new inference identity.
            // Unknown provider/network outcomes keep their original receipt ID.
            if (modelCapture && /^(AI_CAPTURE_STALE|AI_CAPTURE_EXPIRED):/.test(failure)) setAiRequest(undefined)
            setPreviewBusy(false)
          })
        })
    }, 180)
    return () => {
      presentation.cancel()
      window.clearTimeout(id)
    }
  }, [open, text, busy, manualMode, correctionMode, cloud.session, previewRequest, recoveryLocked, modelCapture, aiRequest])

  useEffect(() => { if (!open || manualMode || correctionMode) setAiRequest(undefined) }, [open, manualMode, correctionMode])

  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !sheetRef.current?.contains(event.target)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        dismissCapture()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (correctionMode) { event.preventDefault(); return }
        event.preventDefault()
        void submit()
        return
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open, text, busy, stableCommandId, saveState, correctionMode, manualMode, cloud.session, preview, previewBusy, modelCapture])

  async function submit(invokedControl?: HTMLElement) {
    if (!text.trim() || busy) return
    if (modelCapture && !recoveryLocked && (!currentAiPreview?.ai.canCommit || previewBusy)) {
      setError(zh ? '请先点击整理并核对 AI 预览，再确认保存。' : 'Organize and review the AI preview before saving.')
      return
    }
    if (manualMode) {
      const invalid = sheetRef.current?.querySelector<HTMLInputElement>('input:invalid')
      if (invalid) { invalid.reportValidity(); return }
    }
    const queueOffline = connected && typeof navigator !== 'undefined' && !navigator.onLine
    if (modelCapture && queueOffline) { setError(zh ? 'AI 预览确认需要联网；输入内容已保留。' : 'AI confirmation needs a connection; your input is retained.'); return }
    if (queueOffline && recoveryLocked) return
    const commandId = connected
      ? stableCommandId ?? createConnectedCommandId('web-semantic')
      : undefined
    const operation = operationLifecycle.current.begin(sheetRef.current, document, invokedControl)
    if (!operation) return
    const submittedText = text
    if (commandId) setStableCommandId(commandId)
    setBusy(true)
    setSaveState('saving')
    setMessage('')
    setError('')
    setDecisionCount(0)
    setUnresolvedCount(0)
    try {
      const result = modelCapture ? await confirmAiCapture({ accountKey: accountKey!, commandId: commandId!, text,
        preview: currentAiPreview as AiCapturePreview | undefined, recover: recoveryLocked }) : await submitWebSemanticCapture(text, {
        accountKey: cloud.session?.user.id,
        commandId,
        contextRefs,
        confirmExisting: recoveryLocked,
        queueOffline,
        candidates: manualMode ? [manualJobCandidate(readManualJobDraft(text) ?? manualDraftRef.current)] : undefined,
      })
      if (result.status === 'QUEUED') {
        if (operation.isCurrent()) {
          saveAccountDraft(cloud.session!.user.id, 'tell-pjsdas', submittedText)
          setSaveState('offline')
          setMessage(zh ? '已保存在此设备，联网后自动提交。' : 'Saved on this device; it will submit when connected.')
        }
        return
      }
      if ((result.status === 'APPLIED' || result.status === 'DECISION_REQUIRED') && cloud.session && !connectedWorkspaceAuthorityEnabled()) {
        await ensureAuthoritativePersistence(true, cloud.syncNow)
      }
      if (result.status === 'APPLIED') {
        if (closedDraftRef.current?.accountKey === accountKey && closedDraftRef.current.text === submittedText) closedDraftRef.current = undefined
        if (connected && accountKey && readAccountDraft(accountKey, 'tell-pjsdas') === submittedText) clearAccountDraft(accountKey, 'tell-pjsdas')
      }
      if (operation.isCurrent() || result.status === 'APPLIED' && operation.canReconcileDraft(submittedText, textRef.current)) {
        setError('')
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
          const summary = manualMode ? (zh ? '岗位已保存。' : 'Job saved.') : /^\d+ bounded update\(s\) committed\.$/.test(result.summary.trim())
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
            closedDraftRef.current = undefined
            if (manualMode) manualDraftRef.current = { company: '', role: '' }
            textRef.current = ''
            setText('')
            setPreview(undefined)
          }
        }
      }
      if (result.status !== 'NO_WRITE' && result.status !== 'ALREADY_APPLIED') await onChanged()
    } catch (caught) {
      if (!operation.isCurrent()) return
      const detail = caught instanceof Error ? caught.message : String(caught)
      setError(detail)
      if (caught instanceof WorkspaceWriteAuthError) setSaveState('auth_unconfirmed')
      else if (caught instanceof UnknownCommandOutcomeError) setSaveState('unknown')
      else if (caught instanceof ConnectedProjectionPendingError) setSaveState('confirmed_pending')
      else if (caught instanceof CommandBlockedByPendingProjectionError) {
        setSaveState('blocked_by_pending')
        setStableCommandId(undefined)
      }
      else if (caught instanceof PreExecutionCommandError && caught.code === 'SESSION_EXPIRED_BEFORE_COMMAND') setSaveState('reauth')
      else if (/CONFLICT|conflict/i.test(detail)) setSaveState('conflict')
      else setSaveState('error')
    } finally {
      if (operation.settle()) setBusy(false)
    }
  }

  async function undoLast(invokedControl?: HTMLElement) {
    if (!undo || busy) return
    const operation = operationLifecycle.current.begin(sheetRef.current, document, invokedControl)
    if (!operation) return
    setBusy(true)
    setSaveState('saving')
    setError('')
    try {
      await undoWebSemanticChange(undo)
      if (cloud.session && !connectedWorkspaceAuthorityEnabled()) await ensureAuthoritativePersistence(true, cloud.syncNow)
      if (operation.isCurrent()) {
        setUndo(undefined)
        setSaveState('saved')
        setAuthoritativeSaveConfirmed(false)
        setMessage(zh ? '刚才的权威写入已撤销；其他后续更新保持不变。' : 'The authoritative write was undone; unrelated later updates remain intact.')
      }
      await onChanged()
    } catch (caught) {
      if (!operation.isCurrent()) return
      setError(caught instanceof Error ? caught.message : String(caught))
      setSaveState('conflict')
    } finally {
      if (operation.settle()) setBusy(false)
    }
  }

  function editText(value: string) {
    textRef.current = value
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

  async function importTextFile(file: File) {
    if (busy || recoveryLocked || manualMode || correctionMode || !open) return
    const epoch = ++fileReadEpochRef.current
    const draft = textRef.current
    setFileReading(true); setFileNotice(''); setFileError('')
    try {
      const quote = await readCaptureTextFile(file, '')
      if (epoch !== fileReadEpochRef.current || textRef.current !== draft) return
      setFileAttachment({ name: file.name, quote })
    } catch (caught) {
      if (epoch !== fileReadEpochRef.current) return
      const code = caught instanceof CaptureTextFileError ? caught.code : 'read'
      const copy: Record<string, [string, string]> = {
        format: ['仅支持 UTF-8 文本文件（.txt、.md），暂不支持 PDF、Word 或图片。', 'Use a UTF-8 .txt or .md file. PDF, Word and images are not supported yet.'],
        size: ['文件不能超过 32 KB。', 'Files must be 32 KB or smaller.'],
        encoding: ['文件不是有效的 UTF-8 文本，请转换编码后再添加。', 'This is not valid UTF-8 text. Convert its encoding first.'],
        binary: ['文件包含非文本内容，未加入输入框。', 'The file contains non-text data and was not added.'],
        empty: ['文件没有可读取的文字。', 'The file has no readable text.'],
        length: ['加入后将超过 8000 字符，请缩短内容。', 'The combined text would exceed 8,000 characters. Shorten it first.'],
        read: ['无法读取文件，原输入内容已保留。', 'Could not read the file. Your draft is unchanged.'],
      }
      setFileError(copy[code]![zh ? 0 : 1])
    } finally {
      if (epoch === fileReadEpochRef.current) setFileReading(false)
    }
  }

  function addFileQuote() {
    if (!fileAttachment || busy || recoveryLocked) return
    try {
      editText(appendCaptureQuote(textRef.current, fileAttachment.quote))
      setFileAttachment(undefined)
      setFileNotice(zh ? '文件已作为引用加入。请在引用前说明要记录什么，再核对保存。' : 'File text added as a quote. State what to record before it, then review and save.')
      textareaRef.current?.focus()
    } catch {
      setFileError(zh ? '加入后将超过 8000 字符，请缩短内容。' : 'The combined text would exceed 8,000 characters. Shorten it first.')
    }
  }

  function requestPreview() {
    if (!text.trim() || busy || modelCapture && previewBusy || recoveryLocked) return
    if (modelCapture) {
      if (!connected || !accountKey) { setError(zh ? '请登录并连接工作区后使用 AI 理解。' : 'Sign in and connect your workspace to use AI interpretation.'); return }
      setError('')
      setPreview(undefined)
      processedAiRequest.current = undefined
      // A retry of the same input asks for its durable result, never buys a
      // second inference after an unknown response. Edits get a new identity.
      setAiRequest(previous => previous?.text === text && previous.accountKey === accountKey
        ? { ...previous } : { text, accountKey, requestId: createConnectedCommandId('ai-capture') })
    }
    setPreviewRequest(value => value + 1)
    previewSectionRef.current?.focus()
  }

  function switchManualMode() {
    if (busy || recoveryLocked) return
    if (manualMode) {
      manualDraftRef.current = readManualJobDraft(text) ?? manualDraftRef.current
      setManualMode(false)
      editText(naturalDraftRef.current)
    } else {
      naturalDraftRef.current = text
      setManualMode(true)
      setCorrectionMode(false)
      editText(manualJobDraft(manualDraftRef.current))
    }
  }
  if (!open) return null
  const manualJob = readManualJobDraft(text) ?? { company: '', role: '' }


  const modeNote = preview ? modeExplanation(preview, zh) : undefined
  const moreActions = <button type="button" className="cgr-capture-more" aria-label={zh ? '更多操作' : 'More options'} aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}>＋</button>
  const secondaryActions = moreOpen ? <div className="cgr-capture-secondary">
    {!manualMode && !correctionMode ? <>
          <button ref={fileTriggerRef} type="button" className="cgr-capture-tool" aria-label={zh ? '添加文本文件（.txt、.md）' : 'Add a text file (.txt, .md)'} title={zh ? '仅本地读取文本，最多 32 KB' : 'Read text locally, up to 32 KB'} disabled={busy || recoveryLocked || fileReading} onClick={() => { setFileNotice(zh ? '支持 .txt、.md，最多 32 KB，仅在本地读取。' : 'Text and Markdown (.txt, .md), up to 32 KB. Read locally.'); fileInputRef.current?.click() }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4.25 4.25l-8.5 8.5a5 5 0 0 1-7.07-7.07L12 2.5" /></svg><span>{zh ? '文本文件' : 'Text file'}</span>
          </button>
          <button type="button" className="cgr-capture-voice" disabled aria-label={zh ? '语音输入，正在开发中' : 'Voice input, in development'}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3M9 21h6" /></svg>
            <span>{zh ? '语音 · 开发中' : 'Voice · Coming soon'}</span>
          </button>
    </> : null}
    {!manualMode && !correctionMode ? <button type="button" className="text-button cgr-correction-toggle" disabled={busy || recoveryLocked} onClick={() => setCorrectionMode(true)}>{zh ? '核实已有记录' : 'Review existing records'}</button> : null}
    {!correctionMode ? <button className="text-button cgr-capture-mode" type="button" disabled={busy || recoveryLocked} onClick={switchManualMode}>{manualMode ? (zh ? '用自然语言添加' : 'Use natural language') : (zh ? '手动填写岗位' : 'Enter job manually')}</button> : null}
    {!manualMode && !correctionMode ? <button className="cgr-capture-close" type="button" onClick={() => dismissCapture()} aria-label={zh ? '关闭' : 'Close'}>{zh ? '收起' : 'Close'}</button> : null}
  </div> : null


  return (
    <div className="cgr-capture-popover" style={popoverStyle}>
      <section
        id="tell-pjsdas-composer"
        ref={sheetRef}
        tabIndex={-1}
        className="cgr-capture-sheet"
        role="dialog"
        aria-modal="false"
        aria-label={manualMode ? (zh ? '添加岗位' : 'Add job') : (zh ? '告诉 TodayAction' : 'Tell TodayAction')}
      >
        {contextLabel ? <span className="cgr-capture-context">{contextLabel}</span> : null}
        {manualMode || correctionMode ? <div className="cgr-capture-mode-tools">{moreActions}<button className="cgr-capture-close" type="button" onClick={() => dismissCapture()} aria-label={zh ? '关闭' : 'Close'}>×</button></div> : null}
        {correctionMode ? secondaryActions : null}
        {correctionMode ? <button ref={correctionBackRef} type="button" className="text-button cgr-correction-toggle" disabled={busy || recoveryLocked} onClick={() => setCorrectionMode(false)}>{zh ? '返回记录进展' : 'Back to progress capture'}</button> : null}
        {correctionMode ? <Suspense fallback={<p role="status">{zh ? '正在打开核对入口…' : 'Opening review…'}</p>}><RecordCorrectionReview key={cloud.session?.user.id ?? 'signed-out'} onChanged={onChanged} /></Suspense> : <>
        {manualMode ? <ManualJobFields value={manualJob} onChange={value => { manualDraftRef.current = value; editText(manualJobDraft(value)) }} disabled={busy || recoveryLocked} zh={zh} /> : <>
        <div className="cgr-capture-composer">
        <textarea
          id="tell-pjsdas-input"
          ref={textareaRef}
          className="cgr-capture-input"
          aria-label={zh ? '要告诉 TodayAction 的内容' : 'What to tell TodayAction'}
          rows={1}
          value={text}
          disabled={busy || recoveryLocked}
          onChange={(event) => editText(event.target.value)}
          placeholder={zh ? '说说你的任务或日程…' : 'Tell me about a task or plan…'}
        />
        {fileAttachment ? <div className="cgr-capture-attachment">
          <span title={fileAttachment.name}>{fileAttachment.name}</span>
          <small>{zh ? '本地文本' : 'Local text'}</small>
          <button type="button" disabled={busy || recoveryLocked} onClick={addFileQuote}>{zh ? '加入引用' : 'Add as quote'}</button>
          <button type="button" aria-label={zh ? `移除文件 ${fileAttachment.name}` : `Remove file ${fileAttachment.name}`} disabled={busy || recoveryLocked} onClick={() => { setFileAttachment(undefined); setFileError(''); (fileTriggerRef.current && !fileTriggerRef.current.disabled ? fileTriggerRef.current : textareaRef.current)?.focus() }}>×</button>
        </div> : null}
        <div className="cgr-capture-tools">
          <input ref={fileInputRef} type="file" hidden tabIndex={-1} accept=".txt,.md,text/plain,text/markdown" disabled={busy || recoveryLocked || fileReading}
            onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importTextFile(file) }} />
          {moreActions}
          <button type="button" className="cgr-capture-send" aria-label={zh ? '整理输入内容并预览' : 'Organize input and preview'} title={zh ? '整理并预览' : 'Organize and preview'} disabled={!text.trim() || busy || modelCapture && previewBusy || recoveryLocked} onClick={requestPreview}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
          </button>
        </div>
        </div>
        {fileReading || fileNotice ? <p className="cgr-capture-file-note" role="status">{fileReading ? (zh ? '正在本地读取…' : 'Reading locally…') : fileNotice}</p> : null}
        {fileError ? <p className="cgr-capture-file-error" role="alert">{fileError}</p> : null}

        {text.trim() ? (
          <section ref={previewSectionRef} tabIndex={-1} className="cgr-understanding" aria-label={zh ? '整理结果' : 'Interpretation preview'} aria-live="polite" aria-busy={previewBusy}>
            <div className="cgr-understanding-head">
              <strong>{previewBusy ? (zh ? '正在理解…' : 'Understanding…') : modelCapture && !preview ? (zh ? '点击箭头开始 AI 理解' : 'Use the arrow to interpret with AI') : (zh ? 'TodayAction 理解为' : 'TodayAction understands')}</strong>
              <span data-state={saveState}>
                {saveState === 'auth_unconfirmed' ? (zh ? '等待账号确认' : 'Waiting for account confirmation')
                  : saveState === 'saving' ? (zh ? '正在保存' : 'Saving')
                  : saveState === 'saved' ? (zh ? '已保存' : 'Saved')
                  : saveState === 'unknown' ? (zh ? '等待确认' : 'Confirming')
                  : saveState === 'confirmed_pending' ? (zh ? '服务器已确认，本机待刷新' : 'Server confirmed; device refresh pending')
                    : saveState === 'blocked_by_pending' ? (zh ? '尚未发送' : 'Not sent')
                      : saveState === 'offline' ? (zh ? '待同步' : 'Pending')
                        : (zh ? '尚未保存' : 'Not saved')}
              </span>
            </div>
            {!previewBusy && preview ? (
              <div className="cgr-understanding-body">
                {modeNote ? <p className="cgr-understanding-note">{modeNote}</p> : null}
                {preview.candidates.length ? (
                  <ul>
                    {preview.candidates.map((candidate) => <li key={candidate.id}>
                      {candidateLabel(candidate, zh)}
                      {modelCapture ? aiCandidateDetails(candidate, zh, currentAiPreview?.ai.timezone).map((detail, index) =>
                        <p className="cgr-understanding-note" key={index}>{detail}</p>) : null}
                    </li>)}
                  </ul>
                ) : !modeNote ? (
                  <p className="cgr-understanding-note">{zh ? '还没有识别出可保存的内容。请补充具体事项或时间。' : 'Nothing is ready to save yet. Add the specific task or time.'}</p>
                ) : null}
                {preview.unresolved.length ? (
                  <p className="cgr-understanding-warning">{modelCapture ? preview.unresolved.join(' ') : zh ? `${preview.unresolved.length} 处内容仍需补充或确认，请核对具体事项、对象和时间。` : `${preview.unresolved.length} part(s) need clarification. Check the task, target, and time.`}</p>
                ) : null}
                {preview.ignored.length ? (
                  <p className="cgr-understanding-note">{zh ? `${preview.ignored.length} 个片段未作为当前事实处理（如引用的旧消息）。` : `${preview.ignored.length} fragment(s) were not treated as current facts (such as quoted history).`}</p>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        </>}
        <div className="cgr-capture-actions"
          onPointerEnter={() => previewPresentation.current.hold('pointer', true)}
          onPointerLeave={() => previewPresentation.current.hold('pointer', false)}
          onFocusCapture={() => previewPresentation.current.hold('focus', true)}
          onBlurCapture={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) previewPresentation.current.hold('focus', false)
          }}>
        {secondaryActions}
        {manualMode || text.trim() && preview || busy || recoveryLocked ? <div className="cgr-capture-footer">

          {manualMode || text.trim() && preview || busy || recoveryLocked ? <button className="cgr-primary-button" type="button" disabled={busy || !text.trim() || modelCapture && !recoveryLocked && (!currentAiPreview?.ai.canCommit || previewBusy) || manualMode && (!manualJob.company.trim() || !manualJob.role.trim())} onClick={event => { void submit(event.currentTarget) }}>
            {busy ? (zh ? '正在权威保存…' : 'Saving authoritatively…')
              : saveState === 'unknown' ? (zh ? '确认保存状态' : 'Confirm save status')
                : saveState === 'confirmed_pending' ? (zh ? '核对本机状态' : 'Check device state')
                : saveState === 'offline' ? (zh ? '确认保存状态' : 'Check save status')
                : saveState === 'reauth' ? (zh ? '重新确认' : 'Retry confirmation')
                  : manualMode ? (zh ? '保存岗位' : 'Save job') : (zh ? '确认并保存' : 'Confirm and save')}
          </button> : null}
        </div> : null}
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
              {undo ? <button type="button" disabled={busy} onClick={event => { void undoLast(event.currentTarget) }}>{zh ? '撤销' : 'Undo'}</button> : null}
              {decisionCount > 0 ? <button type="button" onClick={onOpenDecisions}>{zh ? '去决定' : 'Review decisions'}</button> : null}
            </div>
          </div>
        ) : null}

        {unresolvedCount > 0 && !decisionCount ? (
          <p className="cgr-capture-hint">{zh
            ? '尚未明确的内容不会进入 Today。请补充具体事项、时间，或对应的已有记录。'
            : 'Unclear content does not enter Today. Add the task, time, or matching existing record.'}</p>
        ) : null}
        {error ? (
          <div className={`cgr-capture-error state-${saveState}`} role="alert">
            <strong>{saveState === 'ai_preview_error'
              ? (zh ? 'AI 理解暂时不可用' : 'AI interpretation is unavailable')
              : saveState === 'auth_unconfirmed'
              ? (zh ? '账号尚未确认' : 'Account not confirmed')
              : saveState === 'unknown'
              ? (zh ? '保存结果暂时未知' : 'Save outcome is not confirmed yet')
              : saveState === 'confirmed_pending'
                ? (zh ? '服务器已确认，本机待安全刷新' : 'Server confirmed; this device awaits a safe refresh')
              : saveState === 'blocked_by_pending'
                ? (zh ? '这次操作尚未发送' : 'This action was not sent')
              : saveState === 'reauth'
                ? (zh ? '登录会话已过期' : 'Session expired')
                : saveState === 'conflict'
                  ? (zh ? '发现具体事实冲突' : 'A concrete fact conflict was found')
                  : (zh ? '没有完成保存' : 'Save did not complete')}</strong>
            <span>{saveErrorCopy(saveState, zh)}</span>
          </div>
        ) : null}
        </>}
      </section>
    </div>
  )
}
