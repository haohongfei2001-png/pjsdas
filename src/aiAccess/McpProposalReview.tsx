import { useEffect, useMemo, useState } from 'react'
import { applyChangeSet, discardChangeSet, savePendingChangeSet } from '../db.js'
import {
  decodeMcpProposal,
  encodedProposalFromHash,
  removeProposalFromUrl,
  type McpProposalEnvelope,
} from '../ai/mcpProposal.js'
import { useCloud } from '../cloud/CloudContext.js'
import { useUiLanguage } from '../uiLanguage.js'
import './mcpProposalReview.css'

function clearProposalHash() {
  if (typeof window === 'undefined') return
  const cleaned = removeProposalFromUrl(new URL(window.location.href))
  window.history.replaceState({}, '', `${cleaned.pathname}${cleaned.search}${cleaned.hash}`)
}

function announceWorkspaceChange() {
  window.setTimeout(() => window.dispatchEvent(new Event('pjsdas:workspace-replaced')), 0)
}

export default function McpProposalReview() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const cloud = useCloud()
  const [proposal, setProposal] = useState<McpProposalEnvelope | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')

  useEffect(() => {
    if (typeof window === 'undefined') return
    const encoded = encodedProposalFromHash(window.location.hash)
    if (!encoded) return

    let active = true
    try {
      const decoded = decodeMcpProposal(encoded)
      void savePendingChangeSet(decoded.changeSet)
        .then(() => {
          if (!active) return
          clearProposalHash()
          setProposal(decoded)
          announceWorkspaceChange()
        })
        .catch((caught) => {
          if (!active) return
          clearProposalHash()
          setError(caught instanceof Error ? caught.message : String(caught))
        })
    } catch (caught) {
      clearProposalHash()
      setError(caught instanceof Error ? caught.message : String(caught))
    }

    return () => { active = false }
  }, [])

  const operationSummary = useMemo(
    () => proposal?.changeSet.operations.map((item) => item.summary) ?? [],
    [proposal],
  )

  async function applyProposal() {
    if (!proposal) return
    setBusy(true)
    setError('')
    try {
      await applyChangeSet(proposal.changeSet.id)
      announceWorkspaceChange()
      if (cloud.session && !cloud.checkpoint.conflict) {
        try {
          await cloud.syncNow()
          setResult(zh
            ? 'ChangeSet 已应用，并已请求同步到 Google Drive。'
            : 'ChangeSet applied and Google Drive sync was requested.')
        } catch {
          setResult(zh
            ? 'ChangeSet 已应用到本机；Google Drive 同步未完成，请稍后在“导入与设置”中同步。'
            : 'ChangeSet applied locally; Google Drive sync did not complete. Sync later in Import & Settings.')
        }
      } else {
        setResult(zh
          ? 'ChangeSet 已应用到本机。Google Drive 当前未连接；之后连接/同步即可让 ChatGPT 读取到新状态。'
          : 'ChangeSet applied locally. Connect/sync Google Drive later so ChatGPT can read the new state.')
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
      await discardChangeSet(proposal.changeSet.id)
      announceWorkspaceChange()
      setResult(zh ? '这条 ChatGPT 提议已放弃，没有修改求职数据。' : 'Proposal discarded. No job-search data was changed.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!proposal && !error) return null

  return (
    <div className="mcp-proposal-backdrop" role="dialog" aria-modal="true" aria-label={zh ? 'ChatGPT 修改提议' : 'ChatGPT change proposal'}>
      <section className="mcp-proposal-card">
        <div className="mcp-proposal-eyebrow">CHATGPT · CHANGESET · V1.2</div>
        <h2>{zh ? '审阅 ChatGPT 提议' : 'Review ChatGPT proposal'}</h2>

        {proposal ? (
          <>
            <p className="mcp-proposal-safety">{zh
              ? '尚未修改任何求职数据。只有你点击“应用 ChangeSet”后，这些规范化修改才会进入 PJSDAS。'
              : 'No job-search data has changed. These normalized edits enter PJSDAS only after you click Apply ChangeSet.'}</p>
            <div className="mcp-proposal-meta">
              <strong>{proposal.changeSet.title}</strong>
              <span>{proposal.changeSet.id}</span>
              {proposal.workspaceVersion ? <span>{zh ? '提议基于' : 'Proposed from'} {proposal.workspaceVersion}</span> : null}
            </div>
            <div className="mcp-proposal-ops">
              {operationSummary.map((summary, index) => (
                <div key={`${proposal.changeSet.id}:${index}`}><span>{index + 1}</span><p>{summary}</p></div>
              ))}
            </div>
          </>
        ) : null}

        {error ? <div className="mcp-proposal-error">{error}</div> : null}
        {result ? <div className="mcp-proposal-result">{result}</div> : null}

        <div className="mcp-proposal-actions">
          {!result && proposal ? (
            <>
              <button disabled={busy} onClick={() => { void discardProposal() }}>{zh ? '放弃' : 'Discard'}</button>
              <button disabled={busy} onClick={() => setProposal(null)}>{zh ? '稍后处理' : 'Review later'}</button>
              <button className="primary" disabled={busy} onClick={() => { void applyProposal() }}>
                {busy ? '…' : (zh ? '应用 ChangeSet' : 'Apply ChangeSet')}
              </button>
            </>
          ) : (
            <button className="primary" onClick={() => { setProposal(null); setError(''); setResult('') }}>{zh ? '关闭' : 'Close'}</button>
          )}
        </div>
        {!result && proposal ? <small>{zh ? '选择“稍后处理”后，待确认 ChangeSet 仍保留在「历程 → ChangeSet 账本」。' : 'Review later keeps this pending ChangeSet in Timeline → ChangeSet ledger.'}</small> : null}
      </section>
    </div>
  )
}
