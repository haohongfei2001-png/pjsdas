import { Component, useState, type ReactNode } from 'react'
import { exportLocalRecoveryArchive } from './db.js'

export function StartupRecovery({ error, onRetry }: { error: string; onRetry: () => void }) {
  const [message, setMessage] = useState('')
  async function backup() {
    try {
      const archive = await exportLocalRecoveryArchive()
      const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = 'todayaction-recovery-backup.json'
      link.click()
      URL.revokeObjectURL(url)
      setMessage('备份已下载。Backup downloaded.')
    } catch { setMessage('暂时无法读取备份，请重试。Backup unavailable; please retry.') }
  }
  return <main className="startup-recovery" role="alert" style={{ padding: '3rem', maxWidth: '48rem', margin: 'auto' }}>
    <h1>暂时无法打开工作区 · Workspace could not open</h1>
    <p>读取或显示记录时发生错误。现有数据保留，请先导出安全备份再重试。No data has been deleted. Download a recovery backup before retrying.</p>
    <details><summary>错误说明 · Error details</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{error}</pre></details>
    <p><button type="button" onClick={onRetry}>重试 · Retry</button> <button type="button" onClick={() => { void backup() }}>下载安全恢复备份 · Download recovery backup</button></p>
    {message ? <p role="status">{message}</p> : null}
  </main>
}

export class RootErrorBoundary extends Component<{ children: ReactNode }, { error?: string; generation: number }> {
  state: { error?: string; generation: number } = { generation: 0 }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  render() {
    if (this.state.error !== undefined) return <StartupRecovery error={this.state.error} onRetry={() => this.setState({ error: undefined, generation: this.state.generation + 1 })} />
    return <div key={this.state.generation} style={{ display: 'contents' }}>{this.props.children}</div>
  }
}
