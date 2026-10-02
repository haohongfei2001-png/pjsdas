import { useEffect, useRef, useState } from 'react'
import { useCloud } from './cloud/CloudContext.js'
import { connectedWorkspaceAuthorityEnabled, fetchConnectedRemoteWorkspace } from './cloud/connectedWorkspaceRepository.js'
import { captureAccountCacheLease } from './cloud/accountCacheLease.js'
import { executeConnectedBusinessCommand, lookupConnectedCommandReceipt, PreExecutionCommandError, CommandBlockedByPendingProjectionError } from './cloud/authoritativeCommandClient.js'
import { parseCorrectionReviewPacket, prepareRecordCorrection, type CorrectionReviewEntry, type CorrectionReviewPacket } from './recordCorrectionReview.js'
import { useUiLanguage } from './uiLanguage.js'

type Review = ReturnType<typeof prepareRecordCorrection>
const authorityLabels = { official_role: ['官方岗位页', 'Official role page'], official_campaign: ['官方招聘计划', 'Official campaign'], university_repost: ['高校转载', 'University repost'], aggregator: ['第三方聚合', 'Third-party aggregator'], user: ['用户明确说明', 'Explicit user evidence'] } as const
const availabilityLabels = { open: ['已核实开放', 'Verified open'], closed: ['已核实关闭', 'Verified closed'], unknown: ['开放状态未核实', 'Availability unverified'] } as const
export default function RecordCorrectionReview({ onChanged }: { onChanged: () => Promise<void> }) {
  const cloud = useCloud(), { lang } = useUiLanguage(), zh = lang === 'zh'
  const accountId = cloud.session?.user.id
  const [packet, setPacket] = useState<CorrectionReviewPacket>()
  const [selected, setSelected] = useState<CorrectionReviewEntry>()
  const [review, setReview] = useState<Review>()
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false), [receiptFound, setReceiptFound] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const generation = useRef(0), flight = useRef(false), input = useRef<HTMLInputElement>(null)
  const account = useRef(accountId); account.current = accountId
  useEffect(() => {
    generation.current++; flight.current = false
    setPacket(undefined); setSelected(undefined); setReview(undefined); setBusy(false); setMessage(''); setError(''); setUncertain(false); setReceiptFound(false); setAcknowledged(false)
    if (input.current) input.current.value = ''
    return () => { generation.current++; flight.current = false }
  }, [accountId])
  const connected = Boolean(accountId && connectedWorkspaceAuthorityEnabled())
  const current = (epoch: number, owner: string) => generation.current === epoch && account.current === owner
  const copyError = (caught: unknown) => caught instanceof Error ? caught.message : String(caught)

  async function importFile(file?: File) {
    if (flight.current || uncertain) return
    const epoch = ++generation.current, owner = accountId
    setPacket(undefined); setSelected(undefined); setReview(undefined); setAcknowledged(false); setMessage(''); setError(''); setReceiptFound(false); setUncertain(false)
    if (!file || !owner || !connected) return
    try {
      if (file.size > 2_000_000) throw new Error(zh ? '文件超过 2 MB，未导入。' : 'File exceeds 2 MB; nothing was imported.')
      const parsed = parseCorrectionReviewPacket(await file.text())
      if (!current(epoch, owner)) return
      if (parsed.accountId !== owner) throw new Error(zh ? '核对文件不属于当前账号，未导入。' : 'This review file belongs to another account.')
      setPacket(parsed)
    } catch (caught) { if (current(epoch, owner)) setError(copyError(caught)) }
  }
  async function readForReview(entry: CorrectionReviewEntry) {
    if (!packet || !accountId || !connected || flight.current || uncertain) return
    const epoch = generation.current, owner = accountId
    flight.current = true; setBusy(true); setSelected(entry); setReview(undefined); setAcknowledged(false); setMessage(''); setError(''); setReceiptFound(false)
    try {
      const lease = captureAccountCacheLease(owner)
      const remote = await fetchConnectedRemoteWorkspace(owner, lease.assertCurrent)
      if (!current(epoch, owner)) return
      const next = prepareRecordCorrection(packet, entry, remote.snapshot, owner)
      lease.assertCurrent(); setReview(next)
    } catch (caught) { if (current(epoch, owner)) setError(copyError(caught)) }
    finally { if (current(epoch, owner)) { flight.current = false; setBusy(false) } }
  }
  async function checkReceipt() {
    if (!selected || !accountId || !connected || flight.current) return
    const epoch = generation.current, owner = accountId
    flight.current = true; setBusy(true); setError('')
    try {
      const result = await lookupConnectedCommandReceipt(owner, selected.command.commandId)
      if (!current(epoch, owner)) return
      setReceiptFound(Boolean(result)); setUncertain(!result)
      setMessage(result ? (zh ? '服务器已有该操作编号的回执。请在岗位历史中核对；本次没有重发。' : 'The server has a receipt for this command ID. Verify its history; it was not resent.')
        : (zh ? '暂未找到回执，不能判断之前是否完成。保留原操作编号；恢复连接后再次核对，不要换编号重发。' : 'No receipt found yet. Keep the original command ID and check again after connection recovers.'))
      if (result) { setReview(undefined); setAcknowledged(false); await onChanged() }
    } catch (caught) { if (current(epoch, owner)) setError(copyError(caught)) }
    finally { if (current(epoch, owner)) { flight.current = false; setBusy(false) } }
  }
  async function apply() {
    if (!packet || !selected || !review || !acknowledged || !accountId || !connected || flight.current || uncertain || receiptFound) return
    const epoch = generation.current, owner = accountId
    flight.current = true; setBusy(true); setError(''); setMessage('')
    let submitted = false, committed = false
    try {
      if (!navigator.onLine) throw new Error(zh ? '当前离线，未发送。联网后重新核对。' : 'Offline; nothing sent. Review again when connected.')
      const lease = captureAccountCacheLease(owner)
      const remote = await fetchConnectedRemoteWorkspace(owner, lease.assertCurrent)
      if (!current(epoch, owner)) return
      prepareRecordCorrection(packet, selected, remote.snapshot, owner)
      lease.assertCurrent()
      submitted = true
      const result = await executeConnectedBusinessCommand(owner, { type: 'domain', value: selected.command }, { commandId: selected.command.commandId, baseRevision: Number(remote.version.slice(4)), allowProjectionPending: true })
      if (!current(epoch, owner)) return
      setReview(undefined); setAcknowledged(false)
      if (result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') {
        committed = true; setReceiptFound(true); setUncertain(false)
        setMessage(result.localProjection === 'pending' ? (zh ? '服务器已确认；本机显示仍待安全刷新，不要重复发送。' : 'Server confirmed; local display awaits safe refresh. Do not resend.') : (zh ? '服务器已确认，原始证据保留在历史中。' : 'Server confirmed; original evidence remains in history.'))
        await onChanged()
      } else { setError(result.conflict?.message ?? (zh ? '没有保存变化，请重新核对证据。' : 'No change saved; review the evidence again.')) }
    } catch (caught) {
      if (current(epoch, owner)) {
        setError(copyError(caught)); setReview(undefined); setAcknowledged(false)
        if (committed) { setUncertain(false); setMessage(zh ? '服务器已确认，本机刷新失败；请核对原回执，不要重复发送。' : 'Server confirmed; local refresh failed. Check the original receipt, do not resend.') }
        else if (submitted && !(caught instanceof PreExecutionCommandError) && !(caught instanceof CommandBlockedByPendingProjectionError)) { setUncertain(true); setMessage(zh ? '结果尚未确认。只能核对原操作回执，不会生成新的操作编号。' : 'Outcome unconfirmed. Check the original receipt; no new command identity will be generated.') }
      }
    } finally { if (current(epoch, owner)) { flight.current = false; setBusy(false) } }
  }
  return <section className="cgr-correction-review" aria-label={zh ? '核实已有记录' : 'Review existing records'}>
    <h3>{zh ? '核实已有记录' : 'Review existing records'}</h3>
    <p>{zh ? '逐条核对来源后修正。原始证据会保留；这些修正不提供普通撤销。' : 'Review sources one record at a time. Original evidence is retained; ordinary Undo is not available.'}</p>
    <p>{zh ? '完整核对文件仅留在此窗口内存，关闭或切换账号即清除。提交的单条操作沿用账号回执记录。' : 'The full review file stays in window memory and clears on close or account change. Submitted individual commands use the existing account receipt journal.'}</p>
    {!connected ? <p role="status">{zh ? '请先通过设置登录已连接账号；此入口不会修改本地模式的数据。' : 'Sign into a connected account in Settings first. This entry does not change local-mode data.'}</p> : null}
    <label>{zh ? '导入核对文件（JSON，最多 2 MB）' : 'Import review file (JSON, up to 2 MB)'}<input ref={input} type="file" accept="application/json,.json" disabled={!connected || busy || uncertain} onChange={event => { void importFile(event.target.files?.[0]) }} /></label>
    {packet ? <>
      <p>{zh ? '核对基线' : 'Review baseline'}: {packet.workspaceVersion} · {packet.reviewedAt}</p>
      <details><summary>{zh ? '保护与暂缓记录' : 'Protected and held records'} · {packet.excluded.length + packet.held.length}</summary><ul>{[...packet.excluded, ...packet.held].map((item, index) => <li key={index}>{item.opportunityId} · {item.reason}</li>)}</ul></details>
      <ul className="cgr-correction-entries">{packet.entries.map(entry => <li key={entry.command.commandId}><button type="button" disabled={busy || uncertain || entry.reviewStatus !== 'ready'} onClick={() => { void readForReview(entry) }}>{entry.company} · {entry.role} · {entry.command.opportunityId}</button>{entry.reviewStatus !== 'ready' ? <span>{zh ? '证据仍待核实，禁止提交' : 'Evidence needs review; submission blocked'}</span> : null}</li>)}</ul>
    </> : null}
    {selected ? <section className="cgr-understanding">
      <h4>{selected.company} · {selected.role}</h4><p>{selected.command.opportunityId} · {selected.command.commandId}</p>
      {selected.command.kind === 'correct_application_deadline' ? <>
        <p>{zh ? '原截止' : 'Previous deadline'}: {review?.previousDeadline.deadline ?? '—'} → {selected.command.correction.state === 'unknown' ? (zh ? '无可靠截止日期（不代表仍开放）' : 'No verified deadline (does not mean open)') : selected.command.correction.deadline}</p>
        <p>{zh ? '岗位来源状态' : 'Posting availability'}: {availabilityLabels[selected.command.correction.postingStatus][zh ? 0 : 1]} · {authorityLabels[selected.command.correction.sourceAuthority][zh ? 0 : 1]}</p>
        <p><a href={selected.command.correction.sourceUrl} target="_blank" rel="noreferrer">{selected.command.correction.sourceUrl}</a></p>
        <p>{selected.command.correction.evidence}</p><p>{zh ? '来源核验时间' : 'Source checked at'}: {selected.command.correction.checkedAt}</p>
      </> : <><p>{zh ? '撤销错误流程证据的效力，保留原始记录' : 'Invalidate mistaken process evidence; retain the original'}: {selected.command.eventId}</p><p>{selected.command.receiptId} · {selected.command.expectedEventUpdatedAt}</p><p>{selected.command.reason}</p><ul>{selected.command.evidenceRefs.map(ref => <li key={ref}>{ref}</li>)}</ul><p>{zh ? '原阶段' : 'Previous stage'}: {review?.previousStage ?? '—'}</p></>}
      {review ? <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} />{zh ? '我已核对准确岗位、来源证据和保护记录，仅确认这一条修正。' : 'I reviewed the exact role, evidence and protections, and confirm only this correction.'}</label> : null}
      <div className="cgr-capture-footer"><button className="cgr-primary-button" type="button" disabled={!review || !acknowledged || busy || uncertain || receiptFound || !connected} onClick={() => { void apply() }}>{zh ? '确认修正这一条' : 'Apply this correction'}</button><button type="button" disabled={busy || !connected} onClick={() => { void checkReceipt() }}>{zh ? '核对原操作回执' : 'Check original receipt'}</button></div>
    </section> : null}
    {busy ? <p role="status">{zh ? '正在核对服务器…' : 'Checking server…'}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
