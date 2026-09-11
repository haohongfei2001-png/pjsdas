import { useState } from 'react'
import { exportLocalSnapshot, restoreLocalSnapshot } from './db.js'
import { parseSnapshotText, type PJSDASSnapshot } from './snapshot.js'
import './localBackup.css'

interface LocalBackupDockProps {
  onChanged?: () => void
}

function backupFilename(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `pjsdas-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`
}

export default function LocalBackupDock({ onChanged }: LocalBackupDockProps) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<PJSDASSnapshot | null>(null)
  const [previewName, setPreviewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

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
      setMessage(`已导出：${snapshot.data.opportunities.length} 个岗位、${snapshot.data.processEvents.length} 条流程事件、${snapshot.data.timeline?.length ?? 0} 条历程、${snapshot.data.actions.length} 个 Action。`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '导出备份失败。')
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
      setError(caught instanceof Error ? caught.message : '无法读取备份。')
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
      setMessage(`已恢复 ${previewName || '本地备份'}。当前浏览器工作区已被该快照替换。`)
      setPreview(null)
      setPreviewName('')
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '恢复备份失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="backup-dock-trigger" type="button" onClick={() => setOpen(true)}>
        本地备份
      </button>

      {open ? (
        <div className="backup-backdrop" onMouseDown={() => setOpen(false)}>
          <section className="backup-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <div className="backup-header">
              <div>
                <div className="eyebrow">LOCAL DATA SAFETY</div>
                <h2>备份与恢复</h2>
                <p>Process Event、Action 完成状态和 Excel 导入基线都只存在当前浏览器。备份文件不会上传到 GitHub。</p>
              </div>
              <button className="backup-close" type="button" onClick={() => setOpen(false)} aria-label="关闭">×</button>
            </div>

            <div className="backup-actions-grid">
              <article>
                <div className="eyebrow">EXPORT</div>
                <h3>导出完整本地快照</h3>
                <p>适合在清理浏览器数据、换电脑或大版本升级前保存。</p>
                <button className="primary-button" type="button" disabled={busy} onClick={exportBackup}>
                  {busy ? '处理中…' : '导出 JSON 备份'}
                </button>
              </article>

              <article>
                <div className="eyebrow">RESTORE</div>
                <h3>从快照恢复</h3>
                <p>先解析和校验；只有再次确认后才会替换当前浏览器的 PJSDAS 数据。</p>
                <label className="backup-file-button">
                  {busy ? '处理中…' : '选择备份文件'}
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
                  <p>导出于 {formatDateTime(preview.exportedAt)}</p>
                </div>
                <div className="backup-counts">
                  <span>岗位 <strong>{preview.data.opportunities.length}</strong></span>
                  <span>流程 <strong>{preview.data.processes.length}</strong></span>
                  <span>事件 <strong>{preview.data.processEvents.length}</strong></span>
                  <span>Action <strong>{preview.data.actions.length}</strong></span>
                  <span>Prep <strong>{preview.data.prep.length}</strong></span>
                  <span>申请组 <strong>{preview.data.applicationGroups.length}</strong></span>
                  <span>ChangeSet <strong>{preview.data.changeSets?.length ?? 0}</strong></span>
                  <span>历程 <strong>{preview.data.timeline?.length ?? 0}</strong></span>
                </div>
                <div className="backup-danger">
                  <strong>恢复会替换当前本地工作区。</strong>
                  <span>当前数据不会与备份合并。需要保留时请先导出当前快照。</span>
                  <button type="button" disabled={busy} onClick={confirmRestore}>确认恢复</button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  )
}

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}
