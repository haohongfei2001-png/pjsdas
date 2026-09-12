import { useEffect, useMemo, useState } from 'react'
import { discardChangeSet, savePendingChangeSet } from '../db.js'
import { saveDiscoveryInboxFromChangeSet } from '../discoveryInboxStore.js'
import {
  DISCOVERY_REJECTION_REASON_OPTIONS,
  createDiscoveryFeedbackRecords,
  deriveDiscoveryReviewChangeSet,
  type DiscoveryRejectionSelection,
} from '../discoveryFeedback.js'
import { saveDiscoveryFeedbackRecords } from '../discoveryFeedbackStore.js'
import {
  encodedProposalFromHash,
  removeProposalFromUrl,
  type McpProposalEnvelope,
} from '../ai/mcpProposal.js'
import { applyMcpChangeSetWithBaseline, assertMcpChangeSetBaseline } from '../ai/mcpProposalApply.js'
import { useCloud } from '../cloud/CloudContext.js'
import { getAccountCheckpoint } from '../cloud/syncState.js'
import OpportunityAssessmentSummary from '../OpportunityAssessmentSummary.js'
import RichOpportunityFactsSummary from '../RichOpportunityFactsSummary.js'
import { useUiLanguage } from '../uiLanguage.js'
import './mcpProposalReview.css'

const VERIFY_ENDPOINT = 'https://pjsdas-remote-alpha.vercel.app/api/proposal-verify'

function clearProposalHash() {
  if (typeof window === 'undefined') return
  const cleaned = removeProposalFromUrl(new URL(window.location.href))
  window.history.replaceState({}, '', `${cleaned.pathname}${cleaned.search}${cleaned.hash}`)
}

function announceWorkspaceChange() {
  window.setTimeout(() => window.dispatchEvent(new Event('pjsdas:workspace-replaced')), 0)
}

function driveVersion(workspaceVersion?: string) {
  return workspaceVersion?.startsWith('drive:') ? workspaceVersion.slice('drive:'.length) : undefined
}

function formatDeadline(value: string | undefined, zh: boolean) {
  if (!value) return zh ? '来源未明确' : 'Not stated by source'
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function confidenceLabel(value: string, zh: boolean) {
  if (!zh) return value
  if (value === 'high') return '高'
  if (value === 'medium') return '中'
  return '低'
}

function defaultRejectionSelections(ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, { code: 'not_interested' }])) as Record<string, DiscoveryRejectionSelection>
}

export default function McpProposalReview() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const cloud = useCloud()
  const [proposal, setProposal] = useState<McpProposalEnvelope | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [verifying, setVerifying] = useState(() => typeof window !== 'undefined' && Boolean(encodedProposalFromHash(window.location.hash)))
  const [result, setResult] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [rejectionSelections, setRejectionSelections] = useState<Record<string, DiscoveryRejectionSelection>>({})

  useEffect(() => {
    if (typeof window === 'undefined') return
    const token = encodedProposalFromHash(window.location.hash)
    if (!token) {
      setVerifying(false)
      return
    }

    let active = true
    void fetch(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as {
          proposal?: McpProposalEnvelope
          message?: string
        }
        if (!response.ok || !body.proposal) throw new Error(body.message || `Proposal verification failed (HTTP ${response.status}).`)
        return body.proposal
      })
      .then(async (verified) => {
        if (!active) return
        const proposedVersion = driveVersion(verified.workspaceVersion)
        if (proposedVersion) {
          const ownerId = cloud.device.workspaceOwnerUserId
          if (!ownerId) {
            throw new Error(zh
              ? '这条提议来自 Google Drive，但当前浏览器还没有可验证的 PJSDAS 云端基线。请先在“导入与设置”连接并同步 Google Drive，再让 ChatGPT 重新生成提议。'
              : 'This proposal came from Google Drive, but this browser has no verifiable PJSDAS cloud baseline. Connect and sync Google Drive in Import & Settings, then ask ChatGPT for a fresh proposal.')
          }
          const checkpoint = getAccountCheckpoint(ownerId)
          if (!checkpoint.lastSyncedVersion || proposedVersion !== checkpoint.lastSyncedVersion) {
            throw new Error(zh
              ? `这条提议基于 ${verified.workspaceVersion}，但本机最近同步版本是 ${checkpoint.lastSyncedVersion ? `drive:${checkpoint.lastSyncedVersion}` : '未知'}。请先同步 PJSDAS，再让 ChatGPT 重新生成提议。`
              : `This proposal was based on ${verified.workspaceVersion}, while this device last synced ${checkpoint.lastSyncedVersion ? `drive:${checkpoint.lastSyncedVersion}` : 'an unknown version'}. Sync PJSDAS first, then ask ChatGPT for a fresh proposal.`)
          }
        }
        await assertMcpChangeSetBaseline(verified.changeSet)
        if (!active) return
        const discoveryIds = verified.changeSet.operations
          .filter((item) => item.kind === 'add_discovered_opportunity')
          .map((item) => item.id)
        setSelectedIds(new Set(discoveryIds))
        setRejectionSelections(defaultRejectionSelections(discoveryIds))
        setProposal(verified)
      })
      .catch((caught) => {
        if (!active) return
        setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (!active) return
        clearProposalHash()
        setVerifying(false)
      })

    return () => { active = false }
  }, [])

  const operationSummary = useMemo(
    () => proposal?.changeSet.operations.map((item) => item.summary) ?? [],
    [proposal],
  )
  const discoveryOperations = useMemo(
    () => proposal?.changeSet.operations.filter((item) => item.kind === 'add_discovered_opportunity') ?? [],
    [proposal],
  )
  const selectedCount = discoveryOperations.filter((item) => selectedIds.has(item.id)).length

  function toggleDiscovery(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function setRejectionCode(id: string, code: DiscoveryRejectionSelection['code']) {
    setRejectionSelections((current) => ({
      ...current,
      [id]: { ...(current[id] ?? {}), code },
    }))
  }

  async function applyProposal() {
    if (!proposal) return
    setBusy(true)
    setError('')
    try {
      const reviewedChangeSet = discoveryOperations.length
        ? deriveDiscoveryReviewChangeSet(proposal.changeSet, selectedIds)
        : proposal.changeSet
      await assertMcpChangeSetBaseline(reviewedChangeSet)
      await savePendingChangeSet(reviewedChangeSet)
      await applyMcpChangeSetWithBaseline(reviewedChangeSet)

      let feedbackSaved = true
      if (discoveryOperations.length) {
        try {
          await saveDiscoveryFeedbackRecords(createDiscoveryFeedbackRecords(
            proposal.changeSet,
            selectedIds,
            rejectionSelections,
            proposal.discoveryReview,
          ))
        } catch {
          feedbackSaved = false
        }
      }

      announceWorkspaceChange()
      const feedbackNote = discoveryOperations.length && !feedbackSaved
        ? (zh ? '；岗位已应用，但发现反馈记录失败。' : '; jobs applied, but discovery feedback could not be saved.')
        : ''
      const selectionNote = discoveryOperations.length
        ? (zh ? `已选择 ${selectedCount}/${discoveryOperations.length} 个岗位。` : `Selected ${selectedCount}/${discoveryOperations.length} jobs.`)
        : ''

      if (cloud.session && !cloud.checkpoint.conflict) {
        try {
          await cloud.syncNow()
          setResult(zh
            ? `${selectionNote} ChangeSet 已应用，并已请求同步到 Google Drive${feedbackNote}`
            : `${selectionNote} ChangeSet applied and Google Drive sync was requested${feedbackNote}`)
        } catch {
          setResult(zh
            ? `${selectionNote} ChangeSet 已应用到本机；Google Drive 同步未完成，请稍后在“导入与设置”中同步${feedbackNote}`
            : `${selectionNote} ChangeSet applied locally; Google Drive sync did not complete. Sync later in Import & Settings${feedbackNote}`)
        }
      } else {
        setResult(zh
          ? `${selectionNote} ChangeSet 已应用到本机。Google Drive 当前未连接；请在“导入与设置”连接并同步，之后 ChatGPT 才能读取到新状态${feedbackNote}`
          : `${selectionNote} ChangeSet applied locally. Connect and sync Google Drive in Import & Settings before ChatGPT can read the new state${feedbackNote}`)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  async function saveToInbox() {
    if (!proposal || !discoveryOperations.length) return
    setBusy(true)
    setError('')
    try {
      await assertMcpChangeSetBaseline(proposal.changeSet)
      const saved = await saveDiscoveryInboxFromChangeSet(proposal.changeSet)
      await savePendingChangeSet(proposal.changeSet)
      await discardChangeSet(proposal.changeSet.id)
      announceWorkspaceChange()
      if (cloud.session && !cloud.checkpoint.conflict) {
        try {
          await cloud.syncNow()
          setResult(zh ? `已保存 ${saved} 个岗位到发现箱，没有加入 Opportunities；已请求同步到 Google Drive。` : `Saved ${saved} jobs to Discovery Inbox without adding Opportunities; Google Drive sync was requested.`)
        } catch {
          setResult(zh ? `已保存 ${saved} 个岗位到本机发现箱，没有加入 Opportunities；Google Drive 暂未同步。` : `Saved ${saved} jobs to the local Discovery Inbox without adding Opportunities; Google Drive sync did not complete.`)
        }
      } else {
        setResult(zh ? `已保存 ${saved} 个岗位到本机发现箱，没有加入 Opportunities。` : `Saved ${saved} jobs to the local Discovery Inbox without adding Opportunities.`)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  async function discardProposal() {
    if (!proposal) return
    setBusy(true)
    setError('')
    try {
      await savePendingChangeSet(proposal.changeSet)
      await discardChangeSet(proposal.changeSet.id)
      let feedbackSaved = true
      if (discoveryOperations.length) {
        try {
          await saveDiscoveryFeedbackRecords(createDiscoveryFeedbackRecords(
            proposal.changeSet,
            new Set(),
            rejectionSelections,
            proposal.discoveryReview,
          ))
        } catch {
          feedbackSaved = false
        }
      }
      announceWorkspaceChange()
      if (discoveryOperations.length) {
        setResult(zh
          ? `整批岗位已放弃，没有加入 Opportunities。${feedbackSaved ? '已记录你的拒绝反馈，后续发现会尽量避免重复推荐。' : '拒绝反馈记录失败。'}`
          : `The batch was discarded and no jobs were added. ${feedbackSaved ? 'Your rejection feedback was saved for future discovery.' : 'Rejection feedback could not be saved.'}`)
      } else {
        setResult(zh ? '这条 ChatGPT 提议已放弃，没有修改求职数据。' : 'Proposal discarded. No job-search data was changed.')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!proposal && !error && !verifying) return null

  return (
    <div className="mcp-proposal-backdrop" role="dialog" aria-modal="true" aria-label={zh ? 'ChatGPT 修改提议' : 'ChatGPT change proposal'}>
      <section className={`mcp-proposal-card ${discoveryOperations.length ? 'discovery-review' : ''}`}>
        <div className="mcp-proposal-eyebrow">CHATGPT · CHANGESET · {discoveryOperations.length ? 'V1.5 · COMPONENT ASSESSMENT' : 'V1.2'}</div>
        <h2>{discoveryOperations.length ? (zh ? '逐岗位审阅发现结果' : 'Review discovered jobs') : (zh ? '审阅 ChatGPT 提议' : 'Review ChatGPT proposal')}</h2>

        {verifying ? <p className="mcp-proposal-safety">{zh ? '正在验证提议签名、有效期与本机工作区基线…' : 'Verifying proposal signature, expiry, and local workspace baseline…'}</p> : null}

        {proposal ? (
          <>
            <p className="mcp-proposal-safety">{discoveryOperations.length
              ? (zh
                ? '打开链接没有修改数据。招聘事实与匹配度/机会价值分项评估分层显示；只有勾选并应用的岗位会进入 Opportunities。'
                : 'Opening this link changed no data. Source-backed job facts and component assessments are shown separately; only selected jobs are added to Opportunities.')
              : (zh
                ? '打开这条链接没有修改任何 PJSDAS 数据。只有你点击“应用 ChangeSet”后，这些规范化修改才会进入求职数据。'
                : 'Opening this link changed no PJSDAS data. These normalized edits enter your job-search data only after you click Apply ChangeSet.')}</p>
            <div className="mcp-proposal-meta">
              <strong>{proposal.changeSet.title}</strong>
              <span>{proposal.changeSet.id}</span>
              {proposal.workspaceVersion ? <span>{zh ? '提议基于' : 'Proposed from'} {proposal.workspaceVersion}</span> : null}
              <span>{zh ? '链接有效至' : 'Link expires'} {new Date(proposal.expiresAt).toLocaleString()}</span>
            </div>

            {discoveryOperations.length ? (
              <>
                {proposal.discoveryReview ? (
                  <div className="mcp-discovery-screening">
                    <div className="mcp-discovery-screening-head">
                      <strong>{zh ? '质量闸门结果' : 'Quality gate'}</strong>
                      <span>{zh ? `搜索 ${proposal.discoveryReview.received} · 审阅 ${proposal.discoveryReview.accepted} · 去重 ${proposal.discoveryReview.duplicateCount} · 过滤 ${proposal.discoveryReview.rejectedCount} · 暂缓 ${proposal.discoveryReview.deferredCount}` : `searched ${proposal.discoveryReview.received} · review ${proposal.discoveryReview.accepted} · duplicates ${proposal.discoveryReview.duplicateCount} · filtered ${proposal.discoveryReview.rejectedCount} · deferred ${proposal.discoveryReview.deferredCount}`}</span>
                    </div>
                    {(proposal.discoveryReview.skippedDuplicates.length || proposal.discoveryReview.rejectedCandidates.length || proposal.discoveryReview.deferredCandidates.length) ? (
                      <details>
                        <summary>{zh ? '查看没有进入审阅区的岗位' : 'See jobs that did not enter review'}</summary>
                        <div className="mcp-discovery-screening-list">
                          {proposal.discoveryReview.skippedDuplicates.map((item) => <p key={`dup:${item.company}:${item.role}`}><b>{item.company}｜{item.role}</b> · {item.reason}</p>)}
                          {proposal.discoveryReview.rejectedCandidates.map((item) => <p key={`reject:${item.company}:${item.role}`}><b>{item.company}｜{item.role}</b> · {item.reasons?.join('；')}</p>)}
                          {proposal.discoveryReview.deferredCandidates.map((item) => <p key={`defer:${item.company}:${item.role}`}><b>{item.company}｜{item.role}</b> · {item.reason}</p>)}
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : null}

                <div className="mcp-discovery-selection-summary">
                  <strong>{zh ? `已选择 ${selectedCount}/${discoveryOperations.length}` : `${selectedCount}/${discoveryOperations.length} selected`}</strong>
                  <span>{zh ? '取消勾选后可记录拒绝原因。' : 'Unselect a job to record why you do not want it.'}</span>
                </div>

                <div className="mcp-discovery-list">
                  {discoveryOperations.map((operation) => {
                    const item = operation.opportunity
                    const evidence = item.detail?.discovery
                    const selected = selectedIds.has(operation.id)
                    const rejection = rejectionSelections[operation.id] ?? { code: 'not_interested' as const }
                    return (
                      <article className={`mcp-discovery-item ${selected ? 'selected' : 'rejected'}`} key={operation.id}>
                        <div className="mcp-discovery-review-choice">
                          <label>
                            <input type="checkbox" checked={selected} onChange={() => toggleDiscovery(operation.id)} />
                            <span>{selected ? (zh ? '加入 PJSDAS' : 'Add to PJSDAS') : (zh ? '不加入' : 'Do not add')}</span>
                          </label>
                        </div>
                        <div className="mcp-discovery-title">
                          <div>
                            <strong>{item.company}</strong>
                            <h3>{item.role}</h3>
                          </div>
                          <span>{item.roleType}</span>
                        </div>
                        <div className="mcp-discovery-facts">
                          <span>{zh ? '地点' : 'Location'}：{evidence?.location ?? (zh ? '来源未明确' : 'Not stated')}</span>
                          <span>{zh ? '截止' : 'Deadline'}：{formatDeadline(item.deadline, zh)}</span>
                          <span>{zh ? '薪资' : 'Compensation'}：{evidence?.compensationText ?? (zh ? '来源未明确' : 'Not stated')}</span>
                        </div>
                        <div className="mcp-discovery-scores">
                          <span>{zh ? '机会价值' : 'Opportunity'} <b>{item.opportunityValue}</b> · {confidenceLabel(evidence?.opportunityValueConfidence ?? 'low', zh)}</span>
                          <span>{zh ? '匹配度' : 'Fit'} <b>{item.fitScore}</b> · {confidenceLabel(evidence?.fitConfidence ?? 'low', zh)}</span>
                        </div>
                        {evidence?.rationale ? <p className="mcp-discovery-rationale">{evidence.rationale}</p> : null}
                        <RichOpportunityFactsSummary facts={item.detail?.facts} zh={zh} />
                        <OpportunityAssessmentSummary
                          assessment={item.detail?.assessment}
                          fitScore={item.fitScore}
                          opportunityValue={item.opportunityValue}
                          fitConfidence={evidence?.fitConfidence}
                          opportunityValueConfidence={evidence?.opportunityValueConfidence}
                          zh={zh}
                        />
                        {evidence?.profileWarnings?.length ? (
                          <div className="mcp-discovery-warnings">
                            {evidence.profileWarnings.map((warning) => <span key={warning}>{warning}</span>)}
                          </div>
                        ) : null}
                        {!selected ? (
                          <label className="mcp-discovery-rejection-reason">
                            <span>{zh ? '不加入原因' : 'Reason'}</span>
                            <select value={rejection.code} onChange={(event) => setRejectionCode(operation.id, event.target.value as DiscoveryRejectionSelection['code'])}>
                              {DISCOVERY_REJECTION_REASON_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{zh ? option.zh : option.en}</option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        {evidence?.sourceUrl ? (
                          <a className="mcp-discovery-source" href={evidence.sourceUrl} target="_blank" rel="noreferrer">
                            {zh ? '查看招聘来源' : 'Open job source'} · {evidence.sourceTitle}
                          </a>
                        ) : null}
                      </article>
                    )
                  })}
                </div>
              </>
            ) : (
              <div className="mcp-proposal-ops">
                {operationSummary.map((summary, index) => (
                  <div key={`${proposal.changeSet.id}:${index}`}><span>{index + 1}</span><p>{summary}</p></div>
                ))}
              </div>
            )}
          </>
        ) : null}

        {error ? <div className="mcp-proposal-error">{error}</div> : null}
        {result ? <div className="mcp-proposal-result">{result}</div> : null}

        <div className="mcp-proposal-actions">
          {!result && proposal ? (
            <>
              {discoveryOperations.length ? <button disabled={busy} onClick={() => { void saveToInbox() }}>{zh ? '保存到发现箱' : 'Save to Inbox'}</button> : null}
              <button disabled={busy} onClick={() => { void discardProposal() }}>{discoveryOperations.length ? (zh ? '放弃整批' : 'Discard batch') : (zh ? '放弃' : 'Discard')}</button>
              <button className="primary" disabled={busy || (discoveryOperations.length > 0 && selectedCount === 0)} onClick={() => { void applyProposal() }}>
                {busy ? '…' : discoveryOperations.length
                  ? (zh ? `应用已选择的 ${selectedCount} 个` : `Apply ${selectedCount} selected`)
                  : (zh ? '应用 ChangeSet' : 'Apply ChangeSet')}
              </button>
            </>
          ) : !verifying ? (
            <button className="primary" onClick={() => { setProposal(null); setError(''); setResult('') }}>{zh ? '关闭' : 'Close'}</button>
          ) : null}
        </div>
      </section>
    </div>
  )
}
