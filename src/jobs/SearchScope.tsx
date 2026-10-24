import { useEffect, useRef, useState } from 'react'
import { useCloud } from '../cloud/CloudContext.js'
import { useAiAccess } from '../aiAccess/AiAccessContext.js'
import { captureWorkspaceWriteLease } from '../cloud/workspaceWriteLease.js'
import { connectedWorkspaceAuthorityEnabled } from '../cloud/connectedWorkspaceRepository.js'
import { executeConnectedBusinessCommand, createConnectedCommandId } from '../cloud/authoritativeCommandClient.js'
import { ensureAuthoritativePersistence } from '../cloud/authoritativePersistence.js'
import { saveDiscoveryProfile } from '../db.js'
import { discoverySearchScope, isDiscoverySearchScopeConfirmed, type DiscoveryProfile } from '../discoveryProfile.js'
import { discoveryProfileManagementFingerprint } from '../discoveryProfileManagement.js'
import { discoveryReadinessLabel } from '../discoveryReadiness.js'
import { proposeSearchScope } from '../searchScopeDraft.js'
import { discoveryScopeSchema, type DiscoveryScopeInput } from '../discoveryScopeSchema.js'
import { useUiLanguage } from '../uiLanguage.js'
import './searchScope.css'

export default function SearchScope({ profile, blocked, onChanged }: { profile?: DiscoveryProfile; blocked: boolean; onChanged: () => Promise<void> }) {
  const cloud = useCloud(), ai = useAiAccess(), { lang } = useUiLanguage(), zh = lang === 'zh'
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const baseline = useRef<DiscoveryProfile | undefined>(undefined)
  // Synchronous admission protects input even before React commits its next render.
  const dirty = useRef(false)
  const [goal, setGoal] = useState(''), [refinement, setRefinement] = useState('')
  const [draft, setDraft] = useState<DiscoveryScopeInput>(), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const confirmed = Boolean(profile && isDiscoverySearchScopeConfirmed(profile))
  const savedScope = confirmed ? discoverySearchScope(profile) : undefined
  const summary = savedScope ? [savedScope.targetRoleQueries.join(' / '), savedScope.preferredLocations.length ? `${zh ? '地点' : 'Locations'}: ${savedScope.preferredLocations.join(' / ')}` : '', savedScope.titleEquals.length ? `${zh ? '完整标题' : 'Exact title'}: ${savedScope.titleEquals.join(' / ')}` : '', savedScope.titleExcludes.length ? `${zh ? '排除标题' : 'Excluded titles'}: ${savedScope.titleExcludes.join(' / ')}` : ''].filter(Boolean).join(' · ') : (zh ? '尚未确认搜索范围' : 'Search scope not confirmed')
  const status = discoveryReadinessLabel({ verified: ai.statusVerified, enabled: ai.gmailAutomation?.discoveryEnabled, readiness: ai.gmailAutomation?.discoveryReadiness }, zh)
  useEffect(() => () => { dialog.current?.close() }, [])
  function readProfile() {
    baseline.current = profile && structuredClone(profile)
    const saved = confirmed ? discoverySearchScope(profile) : undefined
    setGoal(saved?.searchGoal ?? ''); setRefinement(''); setError(''); setMessage('')
    setDraft(saved ? discoveryScopeSchema.parse(Object.fromEntries(Object.entries(saved).filter(([key]) => !['key', 'version', 'updatedAt'].includes(key)))) : undefined)
  }
  useEffect(() => {
    // AppV8 keys this editor by account. Only its current admitted cache may rebase
    // an untouched open editor; edited drafts retain their exact conflict baseline.
    if (dialog.current?.open && !blocked && !dirty.current && !busy && !message) readProfile()
  }, [profile, blocked, busy, message])
  function open() {
    if (blocked) return
    dirty.current = false
    readProfile()
    dialog.current?.showModal()
  }
  function close() { dialog.current?.close(); trigger.current?.focus() }
  function propose() {
    dirty.current = true
    try { setDraft(proposeSearchScope(draft ? refinement : goal, draft)); setRefinement(''); setError(''); setMessage('') }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }
  async function save() {
    if (!draft || busy || blocked) return
    dirty.current = true
    let lease: ReturnType<typeof captureWorkspaceWriteLease> | undefined
    setBusy(true); setError(''); setMessage('')
    try {
      lease = captureWorkspaceWriteLease(cloud.session?.user.id)
      const value = discoveryScopeSchema.parse(draft)
      const expectedFingerprint = await discoveryProfileManagementFingerprint(baseline.current ?? null)
      lease.assertCurrent()
      if (cloud.session && connectedWorkspaceAuthorityEnabled()) {
        const result = await executeConnectedBusinessCommand(cloud.session.user.id, { type: 'discovery_profile', value, expectedFingerprint }, { commandId: createConnectedCommandId('search-scope') })
        if (!['COMMITTED', 'ALREADY_APPLIED'].includes(result.outcome)) throw new Error(result.conflict?.message ?? 'Search scope was not saved.')
      } else {
        await saveDiscoveryProfile(value, lease.assertCurrent, { profile: baseline.current })
        if (cloud.session) await ensureAuthoritativePersistence(true, cloud.syncNow)
      }
      lease.assertCurrent(); await onChanged(); lease.assertCurrent()
      setMessage(zh ? '搜索范围已保存。尚未执行搜索；开启每日发现仍需已批准的搜索预算。' : 'Search scope saved. No search has run; daily discovery still requires an approved search budget.')
      // A second save must reopen the current authoritative baseline.
      setDraft(undefined)
    } catch (caught) { try { lease?.assertCurrent() } catch { return }; setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { try { lease?.assertCurrent(); setBusy(false) } catch {} }
  }
  const fields: Array<[keyof DiscoveryScopeInput, string, string]> = [
    ['preferredLocations', '地点（未填写则不限）', 'Locations (empty means unrestricted)'],
    ['titleIncludes', '标题包含任一', 'Title includes any'], ['titleEquals', '完整标题仅', 'Exact title'], ['titleExcludes', '标题排除', 'Title excludes'],
    ['mustHave', '事实包含全部', 'Required facts'], ['mustNotHave', '事实排除', 'Excluded facts'],
  ]
  return <div className="ta-search-scope">
    <div className="ta-scope-summary"><span>{summary}</span><button ref={trigger} type="button" disabled={blocked} onClick={open}>{zh ? '搜索范围' : 'Search scope'}</button></div>
    <p className="ta-scope-status">{status}{ai.gmailAutomation?.discoveryLastSuccessAt ? ` · ${zh ? '历史已提交：' : 'Last committed: '}${new Date(ai.gmailAutomation.discoveryLastSuccessAt).toLocaleString()}` : ` · ${zh ? '尚无已提交发现' : 'No committed discovery'}`}</p>
    <dialog ref={dialog} className="ta-scope-dialog" aria-labelledby="ta-scope-title" onCancel={event => { event.preventDefault(); if (!busy) close() }}>
      <header><h2 id="ta-scope-title">{zh ? '每天帮你找新岗位' : 'Find new jobs each day'}</h2><button type="button" aria-label={zh ? '关闭搜索范围' : 'Close search scope'} disabled={busy} onClick={close}>×</button></header>
      {!draft && !message ? <><label htmlFor="ta-scope-goal">{zh ? '你想找什么岗位？' : 'What jobs are you looking for?'}</label><input id="ta-scope-goal" disabled={busy} autoFocus value={goal} maxLength={2400} onChange={e => { dirty.current = true; setGoal(e.target.value) }} /><p>{zh ? '先说明想找什么，再确认少量搜索准则。' : 'Describe the job titles, then confirm a few search criteria.'}</p></> : null}
      {draft ? <><p>{zh ? '将按这些准则搜索；修改后确认保存。' : 'Review these search criteria before saving.'}</p><div className="ta-scope-query-chips" role="group" aria-label={zh ? '检索岗位词' : 'Search terms'}>{draft.targetRoleQueries.map((term, index) => <div className="ta-scope-query-chip" key={index}><input disabled={busy} aria-label={`${zh ? '检索岗位词' : 'Search term'} ${index + 1}`} value={term} maxLength={160} onChange={e => { dirty.current = true; const next = [...draft.targetRoleQueries]; next[index] = e.target.value; setDraft({ ...draft, targetRoleQueries: next }); setError('') }} /><button type="button" disabled={busy} aria-label={`${zh ? '删除检索词' : 'Remove search term'} ${index + 1}`} onClick={() => { dirty.current = true; setDraft({ ...draft, targetRoleQueries: draft.targetRoleQueries.filter((_, i) => i !== index) }) }}>×</button></div>)}</div><div className="ta-scope-criteria">{fields.filter(([key]) => key === 'preferredLocations' || (draft[key] as string[] | undefined)?.length).map(([key, cn, en]) => <label key={key}>{zh ? cn : en}<input disabled={busy} aria-label={zh ? cn : en} value={(draft[key] as string[] | undefined)?.join('、') ?? ''} onChange={e => { dirty.current = true; setDraft({ ...draft, [key]: e.target.value.split(/[、,，]/).map(v => v.trim()).filter(Boolean) }) }} /></label>)}</div>
      <div className="ta-scope-refine"><input disabled={busy} aria-label={zh ? '修改搜索范围' : 'Refine search scope'} placeholder={zh ? '例如：更广一些、不要运营' : 'For example: broader, exclude operations'} value={refinement} maxLength={2400} onChange={e => { dirty.current = true; setRefinement(e.target.value) }} /><button type="button" disabled={!refinement.trim() || busy} onClick={propose}>{zh ? '更新准则' : 'Update criteria'}</button></div></> : null}
      <p>{zh ? '仅整理明确条件，不会自动搜索或改变开关。开启前仍需单独批准搜索预算。' : 'Only explicit criteria are prepared. Search does not start automatically; starting requires a separately approved search budget.'}</p>
      {error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
      <div className="ta-scope-controls">{ai.statusVerified && ai.gmailAutomation?.discoveryEnabled ? <button type="button" disabled={ai.busy || busy} onClick={() => void ai.setDiscoveryAutomationEnabled(false)}>{zh ? '暂停每日发现' : 'Pause daily discovery'}</button> : <button type="button" disabled title={zh ? '需要单独批准的 TA 搜索预算' : 'A separately approved TodayAction search budget is required'}>{zh ? '开启每日发现（待预算）' : 'Start daily discovery (budget required)'}</button>}{ai.errorSource === 'discovery' && ai.error ? <p role="alert">{ai.error}</p> : null}</div>
      <footer><button type="button" disabled={busy} onClick={close}>{zh ? '关闭' : 'Close'}</button>{!message ? <button className="primary-button" disabled={busy || blocked || (!draft && !goal.trim()) || Boolean(draft && !draft.targetRoleQueries.length)} onClick={draft ? () => void save() : propose}>{busy ? (zh ? '保存中…' : 'Saving…') : draft ? (zh ? '保存搜索范围' : 'Save search scope') : (zh ? '整理搜索范围' : 'Prepare search scope')}</button> : null}</footer>
    </dialog>
  </div>
}
