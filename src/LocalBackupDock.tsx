import { useState } from 'react'
import { exportLocalSnapshot, restoreLocalSnapshot } from './db.js'
import { parseSnapshotText, type PJSDASSnapshot } from './snapshot.js'
import { useUiLanguage, type UiLanguage } from './uiLanguage.js'
import './localBackup.css'

interface LocalBackupDockProps {
  onChanged?: () => void
}

function backupFilename(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `pjsdas-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`
}

export default function LocalBackupDock({ onChanged }: LocalBackupDockProps) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<PJSDASSnapshot | null>(null)
  const [previewName, setPreviewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  function clearTransientState() {
    setPreview(null)
    setPreviewName('')
    setMessage('')
    setError('')
  }

  function openDock() {
    clearTransientState()
    setOpen(true)
  }

  function closeDock() {
    if (busy) return
    clearTransientState()
    setOpen(false)
  }

  async function exportBackup() {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const snapshot = await exportLocalSnapshot()
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = backupFilename()
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setMessage(zh
        ? `已导出：${snapshot.data.opportunities.length} 个岗位、${snapshot.data.processEvents.length} 条流程事件、${snapshot.data.timeline?.length ?? 0} 条历程、${snapshot.data.actions.length} 个 Action。`
        : `Exported: ${snapshot.data.opportunities.length} opportunities, ${snapshot.data.processEvents.length} process events, ${snapshot.data.timeline?.length ?? 0} timeline records, and ${snapshot.data.actions.length} actions.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : (zh ? '导出备份失败。' : 'Could not export the backup.'))
    } finally {
      setBusy(false)
    }
  }

  async function readBackup(file?: File) {
    if (!file) return
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const snapshot = parseSnapshotText(await file.text())
      setPreview(snapshot)
      setPreviewName(file.name)
    } catch (caught) {
      setPreview(null)
      setPreviewName('')
      setError(caught instanceof Error ? caught.message : (zh ? '无法读取备份。' : 'Could not read this backup.'))
    } finally {
      setBusy(false)
    }
  }

  async function confirmRestore() {
    if (!preview) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await restoreLocalSnapshot(preview)
      setMessage(zh
        ? `已恢复 ${previewName || '本地备份'}。当前浏览器工作区已被该快照替换。`
        : `Restored ${previewName || 'local backup'}. The current browser workspace has been replaced by this snapshot.`)
      setPreview(null)
      setPreviewName('')
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : (zh ? '恢复备份失败。' : 'Could not restore the backup.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="backup-dock-trigger" type="button" onClick={openDock}>
        {zh ? '本地备份' : 'Local backup'}
      </button>

      {open ? (
        <div className="backup-backdrop" onMouseDown={closeDock}>
          <section className="backup-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <div className="backup-header">
              <div>
                <div className="eyebrow">LOCAL DATA SAFETY</div>
                <h2>{zh ? '备份与恢复' : 'Backup & restore'}</h2>
                <p>{zh
                  ? '备份文件只下载到本地，不上传到 GitHub。恢复会先校验快照，再替换当前浏览器工作区；若已启用云同步，后续仍受同步冲突保护。'
                  : 'Backup files are downloaded locally and never uploaded to GitHub. Restore validates the snapshot before replacing this browser workspace; if cloud sync is enabled, later synchronization still uses conflict protection.'}</p>
              </div>
              <button className="backup-close" type="button" disabled={busy} onClick={closeDock} aria-label={zh ? '关闭' : 'Close'}>×</button>
            </div>

            <div className="backup-actions-grid">
              <article>
                <div className="eyebrow">EXPORT</div>
                <h3>{zh ? '导出完整本地快照' : 'Export a complete local snapshot'}</h3>
                <p>{zh
                  ? '适合在清理浏览器数据、换电脑或大版本升级前保存。'
                  : 'Useful before clearing browser data, moving devices, or making a major upgrade.'}</p>
                <button className="primary-button" type="button" disabled={busy} onClick={exportBackup}>
                  {busy ? (zh ? '处理中…' : 'Processing…') : (zh ? '导出 JSON 备份' : 'Export JSON backup')}
                </button>
              </article>

              <article>
                <div className="eyebrow">RESTORE</div>
                <h3>{zh ? '从快照恢复' : 'Restore from a snapshot'}</h3>
                <p>{zh
                  ? '先解析和校验；只有再次确认后才会替换当前浏览器的 PJSDAS 数据。'
                  : 'PJSDAS parses and validates the file first. Your browser workspace changes only after explicit confirmation.'}</p>
                <label className="backup-file-button">
                  {busy ? (zh ? '处理中…' : 'Processing…') : (zh ? '选择备份文件' : 'Choose backup file')}
                  <input type="file" accept="application/json,.json" disabled={busy} onChange={(event) => readBackup(event.target.files?.[0])} />
                </label>
              </article>
            </div>

            {error ? <div className="backup-notice error">{error}</div> : null}
            {message ? <div className="backup-notice success">{message}</div> : null}

            {preview ? (
              <div className="backup-preview">
                <div>
                  <div className="eyebrow">RESTORE PREVIEW</div>
                  <strong>{previewName}</strong>
                  <p>{zh ? '导出于' : 'Exported'} {formatDateTime(preview.exportedAt, lang)}</p>
                </div>
                <div className="backup-counts">
                  <span>{zh ? '岗位' : 'Opportunities'} <strong>{preview.data.opportunities.length}</strong></span>
                  <span>{zh ? '流程' : 'Processes'} <strong>{preview.data.processes.length}</strong></span>
                  <span>{zh ? '事件' : 'Events'} <strong>{preview.data.processEvents.length}</strong></span>
                  <span>{zh ? 'Action' : 'Actions'} <strong>{preview.data.actions.length}</strong></span>
                  <span>Prep <strong>{preview.data.prep.length}</strong></span>
                  <span>{zh ? '申请组' : 'Application groups'} <strong>{preview.data.applicationGroups.length}</strong></span>
                  <span>ChangeSet <strong>{preview.data.changeSets?.length ?? 0}</strong></span>
                  <span>{zh ? '历程' : 'Timeline'} <strong>{preview.data.timeline?.length ?? 0}</strong></span>
                </div>
                <div className="backup-danger">
                  <strong>{zh ? '恢复会替换当前本地工作区。' : 'Restore replaces the current local workspace.'}</strong>
                  <span>{zh
                    ? '当前数据不会与备份合并。需要保留当前状态时，请先导出；同步冲突不会在这里被静默解决。'
                    : 'Current data is not merged with the backup. Export it first if you need to keep it; sync conflicts are never silently resolved here.'}</span>
                  <button type="button" disabled={busy} onClick={confirmRestore}>{zh ? '确认恢复' : 'Confirm restore'}</button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  )
}

function formatDateTime(iso: string, lang: UiLanguage) {
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}
