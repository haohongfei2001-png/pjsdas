import { useState } from 'react'
import { useUiLanguage } from '../uiLanguage.js'
import { connectedWorkspaceAuthorityEnabled } from './connectedWorkspaceRepository.js'
import {
  executeConnectedMigration,
  inspectConnectedMigration,
  type ConnectedMigrationInspection,
} from './connectedMigrationService.js'
import { useCloud } from './CloudContext.js'
import './connectedMigration.css'

function short(value: string | undefined) {
  return value ? value.slice(0, 12) : '—'
}

export default function ConnectedMigrationCard() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const cloud = useCloud()
  const [inspection, setInspection] = useState<ConnectedMigrationInspection>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const active = connectedWorkspaceAuthorityEnabled()
  const userId = cloud.session?.user.id

  async function inspect() {
    if (!userId) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      setInspection(await inspectConnectedMigration(userId))
    } catch (caught) {
      setInspection(undefined)
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  async function migrate() {
    if (!userId || !inspection || inspection.status !== 'ready') return
    const confirmed = window.confirm(zh
      ? '确认创建 transactional connected workspace？PJSDAS 会先下载一个 migration recovery 文件，然后创建服务端权威副本。此操作不会自动切换当前生产 authority。'
      : 'Create the transactional connected workspace? PJSDAS first downloads a migration recovery file, then creates the server-authoritative copy. This does not switch the current production authority automatically.')
    if (!confirmed) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await executeConnectedMigration(userId)
      setInspection(await inspectConnectedMigration(userId))
      setMessage(result.status === 'already_migrated'
        ? (zh ? 'transactional workspace 已存在且与当前安全候选一致。' : 'The transactional workspace already exists and matches the safe migration candidate.')
        : (zh
            ? 'transactional workspace 已创建并通过 fingerprint 校验。当前 production authority 仍未切换。'
            : 'The transactional workspace was created and fingerprint-verified. Production authority is still unchanged.'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="connected-migration-card">
      <div className="connected-migration-head">
        <div>
          <div className="eyebrow">CONNECTED AUTHORITY</div>
          <h3>{zh ? '域名切换前的数据迁移' : 'Data migration before domain cutover'}</h3>
          <p>{zh
            ? '在旧 origin 仍能读取 IndexedDB 时，把 Local / Drive 安全收敛到 transactional workspace。不同 origin 之间不会尝试直接读取彼此的 IndexedDB。'
            : 'While the legacy origin can still read its IndexedDB, safely converge Local / Drive into the transactional workspace. PJSDAS never tries to read another origin’s IndexedDB directly.'}</p>
        </div>
        <span className={active ? 'active' : ''}>{active ? (zh ? 'TRANSACTIONAL 已启用' : 'TRANSACTIONAL ACTIVE') : (zh ? '准备阶段' : 'PREPARATION')}</span>
      </div>

      {!userId ? (
        <div className="connected-migration-note">{zh ? '先在“连接与自动化”中登录 PJSDAS，再检查迁移状态。' : 'Sign in to PJSDAS under Connections & automation before checking migration state.'}</div>
      ) : (
        <div className="connected-migration-actions">
          <button disabled={busy} onClick={() => { void inspect() }}>{busy ? '…' : (zh ? '检查迁移状态' : 'Check migration state')}</button>
          {inspection?.status === 'ready' ? <button className="primary-button" disabled={busy} onClick={() => { void migrate() }}>{zh ? '创建 transactional workspace' : 'Create transactional workspace'}</button> : null}
        </div>
      )}

      {inspection?.status === 'ready' ? (
        <div className="connected-migration-state ready">
          <strong>{zh ? '可以迁移' : 'Ready to migrate'}</strong>
          <span>{zh ? '安全来源' : 'Safe source'}: {inspection.plan.source}</span>
          <span>fingerprint: {short(inspection.plan.fingerprint)}</span>
          <p>{inspection.plan.reason}</p>
        </div>
      ) : null}

      {inspection?.status === 'already_migrated' ? (
        <div className="connected-migration-state done">
          <strong>{zh ? '服务端副本已准备好' : 'Server copy is ready'}</strong>
          <span>fingerprint: {short(inspection.connectedFingerprint)}</span>
          <p>{zh ? '下一步是生产配置切换，不需要再次迁移数据。' : 'The next step is production configuration cutover; data migration does not need to run again.'}</p>
        </div>
      ) : null}

      {inspection?.status === 'conflict' ? (
        <div className="connected-migration-state conflict">
          <strong>{zh ? '迁移已停止：存在分叉' : 'Migration stopped: divergent state'}</strong>
          <p>{inspection.reason}</p>
          <span>local {short(inspection.localFingerprint)} · drive {short(inspection.driveFingerprint)} · connected {short(inspection.connectedFingerprint)}</span>
        </div>
      ) : null}

      {message ? <div className="connected-migration-message">{message}</div> : null}
      {error ? <div className="connected-migration-error">{error}</div> : null}
    </section>
  )
}
