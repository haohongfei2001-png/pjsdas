import { useEffect, useMemo, useState } from 'react'
import { applyChangeSet, discardChangeSet, savePendingChangeSet } from '../db.js'
import {
  encodedProposalFromHash,
  removeProposalFromUrl,
  type McpProposalEnvelope,
} from '../ai/mcpProposal.js'
import { useCloud } from '../cloud/CloudContext.js'
import { getAccountCheckpoint } from '../cloud/syncState.js'
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

export default function McpProposalReview() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const cloud = useCloud()
  const [proposal, setProposal] = useState<McpProposalEnvelope | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [verifying, setVerifying] = useState(() => typeof window !== 'undefined' && Boolean(encodedProposalFromHash(window.location.hash)))
  const [result, setResult] = useState('')

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
        const ownerId = cloud.device.workspaceOwnerUserId
        const checkpoint = ownerId ? getAccountCheckpoint(ownerId) : cloud.checkpoint
        const proposedVersion = driveVersion(verified.workspaceVersion)
        if (proposedVersion && checkpoint.lastSyncedVersion && proposedVersion !== checkpoint.lastSyncedVersion) {
          throw new Error(zh
            ? `这条提议基于 Google Drive ${verified.workspaceVersion}，但本机最近同步的是 drive:${checkpoint.lastSyncedVersion}。请先同步 PJSDAS，再让 ChatGPT 重新生成提议。`
            : `This proposal was based on ${verified.workspaceVersion}, while this device last synced drive:${checkpoint.lastSyncedVersion}. Sync PJSDAS first, then ask ChatGPT to create a fresh proposal.`)
        }
        await savePendingChangeSet(verified.changeSet)
        if (!active) return
        setProposal(verified)
        announceWorkspaceChange()
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

  if (!proposal && !error && !verifying) return null

  return (
    <div className="mcp-proposal-backdrop" role="dialog" aria-modal="true" aria-label={zh ? 'ChatGPT 修改提议' : 'ChatGPT change proposal'}>
      <section className="mcp-proposal-card">
        <div className="mcp-proposal-eyebrow">CHATGPT · CHANGESET · V1.2</div>
        <h2>{zh ? '审阅 ChatGPT 提议' : 'Review ChatGPT proposal'}</h2>

        {verifying ? <p className="mcp-proposal-safety">{zh ? '正在验证提议签名与有效期…' : 'Verifying proposal signature and expiry…'}</p> : null}

        {proposal ? (
          <>
            <p className="mcp-proposal-safety">{zh
              ? '尚未修改任何求职数据。只有你点击“应用 ChangeSet”后，这些规范化修改才会进入 PJSDAS。'
              : 'No job-search data has changed. These normalized edits enter PJSDAS only after you click Apply ChangeSet.'}</p>
            <div className="mcp-proposal-meta">
              <strong>{proposal.changeSet.title}</strong>
              <span>{proposal.changeSet.id}</span>
              {proposal.workspaceVersion ? <span>{zh ? '提议基于' : 'Proposed from'} {proposal.workspaceVersion}</span> : null}
              <span>{zh ? '链接有效至' : 'Link expires'} {new Date(proposal.expiresAt).toLocaleString()}</span>
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
          ) : !verifying ? (
            <button className="primary" onClick={() => { setProposal(null); setError(''); setResult('') }}>{zh ? '关闭' : 'Close'}</button>
          ) : null}
        </div>
        {!result && proposal ? <small>{zh ? '选择“稍后处理”后，待确认 ChangeSet 仍保留在「历程 → ChangeSet 账本」。' : 'Review later keeps this pending ChangeSet in Timeline → ChangeSet ledger.'}</small> : null}
      </section>
    </div>
  )
}
