import { useEffect, useRef, useState } from 'react'
import type { ApplicationGroup, Opportunity } from '../model.js'
import { useUiLanguage } from '../uiLanguage.js'
import { captureWorkspaceWriteLease } from '../cloud/workspaceWriteLease.js'
import { connectedWorkspaceAuthorityEnabled } from '../cloud/connectedWorkspaceRepository.js'
import type { LocalSemanticUndoToken } from '../webSemanticIntake.js'
import type { StopFollowingState } from './stopFollowingCommand.js'

interface Props {
  opportunity: Opportunity
  applicationGroup?: ApplicationGroup
  accountKey?: string
  blocked: boolean
  onCapture: () => void
  onChanged: () => Promise<void>
}

/** Contextual internal participation only; never external withdrawal. The parent
 * keys this component by account and job, so an old async completion cannot
 * update another job/account (including an A → B → A account transition). */
export default function StopFollowingAction({ opportunity, applicationGroup, accountKey, blocked, onCapture, onChanged }: Props) {
  const zh = useUiLanguage().lang === 'zh'
  const [state, setState] = useState<StopFollowingState>({ status: 'idle' })
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [localUndo, setLocalUndo] = useState<LocalSemanticUndoToken>()
  const [decisionRequired, setDecisionRequired] = useState(false)
  const mounted = useRef(false), flight = useRef(false), sequence = useRef(0)
  const changed = useRef(onChanged); changed.current = onChanged
  const connected = Boolean(accountKey && connectedWorkspaceAuthorityEnabled())
  const lockAvailable = !connected || (typeof navigator !== 'undefined' && Boolean(navigator.locks?.request))
  const governed = Boolean(applicationGroup && (applicationGroup.locked || applicationGroup.total !== undefined
    || applicationGroup.remaining !== undefined || applicationGroup.rule?.trim()))

  useEffect(() => {
    let active = true
    mounted.current = true
    const refresh = () => {
      if (!connected || !accountKey || blocked || flight.current) return
      const observed = ++sequence.current
      let lease: ReturnType<typeof captureWorkspaceWriteLease>
      try { lease = captureWorkspaceWriteLease(accountKey) } catch { return }
      void import('./stopFollowingCommand.js').then(client => { lease.assertCurrent(); return client.inspectStopFollowing(accountKey, opportunity.id) }).then(value => {
        lease.assertCurrent()
        if (active && observed === sequence.current && !flight.current) { setState(value); setError(undefined) }
      }).catch(caught => {
        try { lease.assertCurrent() } catch { return }
        if (active && observed === sequence.current && !flight.current) setError(caught instanceof Error ? caught.message : String(caught))
      })
    }
    refresh()
    // No event payload supplies account authority. Re-read this account's locator
    // and original receipt; a notification never creates or re-sends a command.
    window.addEventListener('pjsdas:command-recovered', refresh)
    window.addEventListener('storage', refresh)
    return () => { active = false; mounted.current = false; window.removeEventListener('pjsdas:command-recovered', refresh); window.removeEventListener('storage', refresh) }
  }, [accountKey, opportunity.id, connected, blocked])

  async function run(undo = false) {
    if (blocked || flight.current) return
    let lease: ReturnType<typeof captureWorkspaceWriteLease>
    try { lease = captureWorkspaceWriteLease(accountKey) } catch (caught) { setError(String(caught)); return }
    sequence.current += 1
    flight.current = true; setBusy(true); setError(undefined)
    let client: typeof import('./stopFollowingCommand.js') | undefined
    try {
      let next: StopFollowingState
      if (connected && accountKey) {
        client = await import('./stopFollowingCommand.js'); lease.assertCurrent()
        if (!mounted.current) return
        next = undo ? await client.undoStopFollowing(accountKey, opportunity.id) : await client.stopFollowing(accountKey, opportunity.id, { newDecision: state.status === 'confirmed' && opportunity.participationStatus !== 'abandoned' })
      } else if (undo && localUndo) {
        const local = await import('../webSemanticIntake.js'); lease.assertCurrent()
        if (!mounted.current) return
        await local.undoWebSemanticChange(localUndo); next = { status: 'undone' }
      } else {
        const [{ submitWebSemanticCapture }, { createConnectedCommandId }] = await Promise.all([import('../webSemanticIntake.js'), import('../cloud/authoritativeCommandClient.js')])
        lease.assertCurrent(); if (!mounted.current) return
        const result = await submitWebSemanticCapture(`不再跟进 | ${opportunity.id}`, {
          accountKey, commandId: createConnectedCommandId('stop-following-local'), contextRefs: [opportunity.id],
          candidates: [{ id: 'stop-following', kind: 'abandon_opportunity', target: { opportunityId: opportunity.id },
            objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }],
        })
        lease.assertCurrent()
        if (!mounted.current) return
        setLocalUndo(result.undo)
        setDecisionRequired(result.status === 'DECISION_REQUIRED')
        next = { status: result.status === 'APPLIED' ? 'confirmed' : 'no_write', undoAvailable: Boolean(result.undo) }
      }
      lease.assertCurrent()
      if (!mounted.current) return
      await changed.current()
      lease.assertCurrent()
      if (mounted.current) { setState(next); if (next.status === 'undone') setLocalUndo(undefined) }
    } catch (caught) {
      try { lease.assertCurrent() } catch { return }
      if (!mounted.current) return
      if (connected && accountKey && client) {
        try { setState(client.retainedStopFollowing(accountKey, opportunity.id)) } catch { /* Keep corrupt bytes and show the error. */ }
      }
      const message = caught instanceof Error ? caught.message : String(caught)
      if (message.includes('SHARED_GOVERNANCE_REQUIRED')) setDecisionRequired(true)
      setError(message)
    } finally { flight.current = false; if (mounted.current) setBusy(false) }
  }

  const pending = state.status === 'pending' || state.status === 'projection_pending'
  const abandoned = opportunity.participationStatus === 'abandoned'
  const needsReview = governed || decisionRequired
  return <div className="job-stop-following">
    {!abandoned && (state.status !== 'confirmed' || state.currentAbandoned === false) && !pending && state.status !== 'conflict' ?
      <button type="button" className="job-detail-stop" disabled={blocked || busy}
        onClick={needsReview || !lockAvailable ? onCapture : () => { void run() }}>
        {busy ? (zh ? '正在确认…' : 'Confirming…') : (zh ? '不再跟进' : 'Stop following')}
      </button> : null}
    {pending ? <p role="status">{state.status === 'projection_pending' ? (zh ? '服务器已确认，本机状态待安全刷新；不会重复提交。' : 'The server confirmed this operation. Local state awaits a safe refresh; it will not be resubmitted.') : state.automaticRecovery ? (zh ? '这次操作尚未确认。原记录已保留，联网后会自动核对。' : 'Not yet confirmed. The original operation is retained for automatic recovery.') : (zh ? '原操作尚未确认是否发送。请选择“核对原操作”；不会自动创建新决定。' : 'The original operation may not have been sent. Check the original operation; no new decision is created automatically.')}
      <button type="button" disabled={blocked || busy} onClick={() => { void run(state.undoPending) }}>{zh ? '核对原操作' : 'Check original operation'}</button></p> : null}
    {state.status === 'conflict' ? <p role="alert">{zh ? '原操作与较新的记录冲突，未自动重做。请到设置核对待处理操作。' : 'The original operation conflicts with newer facts. It was not repeated. Review pending operations in Settings.'}</p> : null}
    {state.status === 'confirmed' || (abandoned && state.status === 'idle') ? <p role="status">{abandoned ? (zh ? '已不再跟进。历史和招聘方流程保留，未向外部撤回申请。' : 'No longer following. History and recruiting facts remain; no external application was withdrawn.') : (zh ? '已找到这次不再跟进的原回执；当前岗位状态以后续记录为准。' : 'The original stop-following receipt was found; later records determine the current job state.')}
      {state.undoAvailable ? <button type="button" disabled={blocked || busy} onClick={() => { void run(true) }}>{zh ? '撤销不再跟进' : 'Undo stop following'}</button> : null}</p> : null}
    {state.status === 'undone' ? <p role="status">{zh ? '已撤销这次不再跟进。' : 'This stop-following decision was undone.'}</p> : null}
    {state.status === 'no_write' ? <p role="status">{zh ? '本次没有新增不再跟进记录。' : 'No new stop-following decision was recorded.'}</p> : null}
    {needsReview && !abandoned ? <p>{zh ? '涉及共享投递规则，请在“告诉 TodayAction”中核对并确认；这里不会替你作出共享决定。' : 'Shared application rules need review in Tell TodayAction; this control will not make that shared decision for you.'}
      <button type="button" disabled={blocked || busy} onClick={onCapture}>{zh ? '前往核对' : 'Review in Tell TodayAction'}</button></p> : null}
    {!lockAvailable ? <p role="status">{zh ? '此浏览器不能安全协调多页面操作。请使用“告诉 TodayAction”记录；此处没有提交。' : 'This browser cannot safely coordinate this operation across tabs. Use Tell TodayAction; nothing was submitted here.'}</p> : null}
    {error ? <p role="alert">{zh ? '尚未完成确认：' : 'Confirmation incomplete: '}{error}</p> : null}
  </div>
}
