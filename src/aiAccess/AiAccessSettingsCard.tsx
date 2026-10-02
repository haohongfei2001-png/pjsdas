import { useState } from 'react'
import { useAiAccess } from './AiAccessContext.js'
import { useUiLanguage } from '../uiLanguage.js'
import GmailIntakeStatus from './GmailIntakeStatus.js'
import '../cloud/cloudSettings.css'

type Source = 'workspace' | 'discovery' | 'gmail'

export default function AiAccessSettingsCard() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const ai = useAiAccess()
  const automation = ai.gmailAutomation
  const [actionSource, setActionSource] = useState<Source>('workspace')
  const run = (source: Source, action: () => Promise<void>) => { setActionSource(source); void action() }
  const gmailButton = automation?.gmailEnabled
    ? (zh ? '关闭自动跟踪' : 'Disable tracking')
    : automation?.gmailScopeGranted
      ? (zh ? '启用自动跟踪' : 'Enable tracking')
      : (zh ? '授权 Gmail 并启用' : 'Authorize Gmail and enable')
  const discoveryButton = automation?.discoveryEnabled
    ? (zh ? '关闭后台发现' : 'Disable discovery')
    : (zh ? '启用后台发现' : 'Enable discovery')
  const gmailPermission = zh
    ? '点击启用即同意：以 Gmail 只读权限回补最近90天邮件（含已归档、不含垃圾箱/垃圾邮件），以后定期读取新增招聘邮件，并保存必要的公司、岗位、招聘进展、时间、地点与会议链接。原始正文不保存，附件和链接页面不读取；不发送或修改邮件。已有连接不会自动扩大范围，关闭后重新启用才采用上述范围。'
    : 'By enabling Gmail read-only access, you consent to backfill of the last 90 days, including archived mail and excluding spam/trash, followed by periodic checks for new recruiting mail. TodayAction stores necessary recruiting facts, times, locations and meeting links, but no raw bodies. Raw email bodies are never persisted in TodayAction; ambiguous messages remain unresolved. It does not read attachments or linked pages, or send/change mail. Existing connections keep their previous scope until disabled and explicitly enabled again.'
  const discoveryPermission = zh
    ? '启用后，TodayAction 按你的岗位偏好和决策规则检索公开招聘信息，避免重复加入。搜索模型只收到有限的岗位发现条件，不会收到完整工作区、Gmail 正文或无关个人资料；关闭后停止后台公开网页搜索。'
    : 'When enabled, TodayAction searches public job information using your preferences and decision rules, without adding duplicates. The search model receives only bounded discovery criteria, never your full workspace, Gmail bodies, or unrelated personal data. Turning this off stops background public-web search.'
  const sourceState = (enabled: boolean | undefined, error: string | null | undefined) => !automation || !ai.statusVerified
    ? (zh ? '状态待核对' : 'Status unverified')
    : enabled && error ? (zh ? '已启用 · 需要处理' : 'Enabled · Needs attention')
      : enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '未启用' : 'Disabled')
  const result = (source: Source) => ai.errorSource === source && ai.error
    ? <div className="cloud-error" role="alert">{ai.error}</div> : null

  return (
    <div className="cloud-settings-card settings-sources">
      <div className="eyebrow settings-source-eyebrow">BACKGROUND SOURCES</div>
      {ai.errorSource === 'status' && ai.error ? <div className="cloud-error" role="alert"><strong>{zh ? '后台来源状态暂时无法核对' : 'Background source status is unavailable'}</strong><p>{ai.error}</p></div> : null}
      <section className="settings-source-panel" aria-labelledby="settings-workspace-heading">
        <header className="settings-source-header">
          <div><h2 id="settings-workspace-heading">{zh ? '后台工作区连接' : 'Background workspace connection'}</h2>
            <p>{zh ? '让已授权的来源在网页关闭后继续更新工作区。' : 'Let authorized sources update your workspace while the page is closed.'}</p></div>
          <span className={`cloud-state ${ai.statusVerified && automation?.googleEmail ? 'online' : ''}`}>{!automation || !ai.statusVerified ? (zh ? '状态待核对' : 'Status unverified') : automation.googleEmail ? (zh ? '已连接' : 'Connected') : (zh ? '待连接' : 'Not connected')}</span>
        </header>
        <div className="settings-source-operation">
          <div><strong>{automation?.googleEmail || (zh ? '连接后台工作区' : 'Connect background workspace')}</strong>
            {!automation?.googleEmail ? <p className="settings-permission">{zh ? '只申请 Google Drive 的应用专用文件权限，不会浏览普通 Drive 文件。Google 长期授权信息会加密保存。' : 'This requests only access to app-specific Google Drive files, not your normal Drive files. Long-lived Google authorization is encrypted.'}</p> : null}</div>
          <button className={automation?.googleEmail ? 'settings-quiet-button' : 'primary-button'} disabled={ai.busy} onClick={() => run('workspace', ai.beginGoogleDriveLink)}>
            {ai.busy && actionSource === 'workspace' ? (zh ? '处理中…' : 'Working…') : automation?.googleEmail ? (zh ? '重新连接' : 'Reconnect') : (zh ? '使用 Google 连接' : 'Connect with Google')}
          </button>
        </div>
        {ai.message ? <div className="cloud-result" role="status">{ai.message}</div> : null}
        {result('workspace')}
        <details className="settings-scope-details"><summary>{zh ? '连接权限与后台工作方式' : 'Connection access and background operation'}</summary><p>{zh ? '只申请 Google Drive 的应用专用文件权限，不会浏览普通 Drive 文件。Google 长期授权信息会加密保存。重新连接将打开 Google 授权页面。' : 'Access is limited to app-specific Google Drive files. Long-lived authorization is encrypted. Reconnecting opens the Google consent page.'}</p><p>{zh
          ? '网页关闭后，已授权的来源仍可带来新的岗位和招聘进展。AI 读取与受信任的岗位发现、招聘邮件摄入只能加入有来源依据的有限事实；修改长期偏好、拒绝决定或删除资料仍需你审阅确认。每项来源都能单独关闭。新进展须经过来源、身份、重复项和冲突检查，才会写入工作区。'
          : 'Authorized sources can bring in new opportunities and recruiting progress while this page is closed. AI reading and trusted discovery or recruiting-email intake may add only bounded, source-backed facts; changes to durable preferences, rejection decisions, or deletions still require your review. Each source can be turned off. New progress is checked for source, identity, duplicates, and conflicts before it enters your workspace.'}</p></details>
      </section>

      <section className="settings-source-panel" aria-labelledby="settings-discovery-heading">
        <header className="settings-source-header"><div><h2 id="settings-discovery-heading">{zh ? '后台岗位发现' : 'Background job discovery'}</h2><p>{zh ? '按已保存的偏好检索公开招聘信息。' : 'Search public job information using your saved preferences.'}</p></div>
          <span className={`cloud-state ${ai.statusVerified && automation?.discoveryEnabled ? automation.discoveryLastError ? 'warning' : 'online' : ''}`}>{sourceState(automation?.discoveryEnabled, automation?.discoveryLastError)}</span></header>
        <div className="settings-source-operation"><div>
          {automation?.discoveryLastSuccessAt ? <p>{zh ? '最近成功发现：' : 'Last successful discovery: '}{new Date(automation.discoveryLastSuccessAt).toLocaleString()}</p> : <p>{zh ? '尚无可核对的成功发现记录' : 'No verified successful discovery yet'}</p>}
          {!automation?.discoveryEnabled ? <p className="settings-permission">{discoveryPermission}</p> : null}
        </div><button className={automation?.discoveryEnabled ? 'settings-quiet-button' : 'primary-button'} disabled={ai.busy} onClick={() => run('discovery', () => ai.setDiscoveryAutomationEnabled(!automation?.discoveryEnabled))}>{ai.busy && actionSource === 'discovery' ? (zh ? '处理中…' : 'Working…') : discoveryButton}</button></div>
        {automation?.discoveryEnabled && automation.discoveryLastError ? <div className="cloud-connection-impact warning" role="status"><strong>{zh ? '新岗位可能延迟出现' : 'New opportunities may be delayed'}</strong><span>{zh ? '最近一次后台发现失败。已保存的岗位仍可用；检查连接状态后再试。' : 'The latest background search failed. Saved opportunities remain available; check the connection before trying again.'}</span><details><summary>{zh ? '错误详情' : 'Error details'}</summary>{automation.discoveryLastError}</details></div> : null}
        {result('discovery')}
        {automation?.discoveryEnabled ? <details className="settings-scope-details"><summary>{zh ? '查看发现范围与权限' : 'Review discovery scope and access'}</summary><p>{discoveryPermission}</p></details> : null}
      </section>

      <section className="settings-source-panel" aria-labelledby="settings-gmail-heading">
        <header className="settings-source-header"><div><h2 id="settings-gmail-heading">{zh ? '招聘邮件自动跟踪' : 'Automatic recruiting-email tracking'}</h2><p>{zh ? '从授权邮箱提取招聘进展，保留来源与核对结果。' : 'Read recruiting progress from your authorized mailbox, with source and reconciliation records.'}</p></div>
          <span className={`cloud-state ${ai.statusVerified && automation?.gmailEnabled ? automation.gmailLastError ? 'warning' : 'online' : ''}`}>{sourceState(automation?.gmailEnabled, automation?.gmailLastError)}</span></header>
        <div className="settings-source-operation"><div>
          {automation?.gmailLastSuccessAt ? <p>{zh ? '最近成功检查：' : 'Last successful check: '}{new Date(automation.gmailLastSuccessAt).toLocaleString()}</p> : <p>{zh ? '尚无可核对的成功检查记录' : 'No verified successful check yet'}</p>}
          {!automation?.gmailEnabled || automation?.gmailLastError ? <p className="settings-permission">{gmailPermission}</p> : null}
        </div><button className={automation?.gmailEnabled ? 'settings-quiet-button' : 'primary-button'} disabled={ai.busy} onClick={() => run('gmail', () => ai.setGmailAutomationEnabled(!automation?.gmailEnabled))}>{ai.busy && actionSource === 'gmail' ? (zh ? '处理中…' : 'Working…') : gmailButton}</button></div>
        {automation?.gmailEnabled && automation.gmailLastError ? <div className="cloud-connection-impact warning" role="status"><strong>{zh ? '新邮件进展可能未同步' : 'New email progress may be missing'}</strong><span>{zh ? '最近一次邮件检查失败，已有资料仍可查看。重新授权会再次请求上方说明的 90 天 Gmail 只读范围；请先查看 Google 同意页面。' : 'The latest email check failed; saved data remains available. Reauthorizing requests the 90-day Gmail read-only scope described above again; review the Google consent screen first.'}</span><details><summary>{zh ? '错误详情' : 'Error details'}</summary>{automation.gmailLastError}</details><button type="button" disabled={ai.busy} onClick={() => run('gmail', ai.beginGmailAutomationLink)}>{zh ? '查看并重新授权 Gmail' : 'Review and reauthorize Gmail'}</button></div> : null}
        {result('gmail')}
        <GmailIntakeStatus zh={zh} enabled={ai.statusVerified && automation ? automation.gmailEnabled : undefined} lastSuccessAt={automation?.gmailLastSuccessAt ?? undefined} lastError={automation?.gmailLastError ?? undefined} />
        {automation?.gmailEnabled && !automation.gmailLastError ? <details className="settings-scope-details"><summary>{zh ? '查看邮件读取范围与权限' : 'Review email scope and access'}</summary><p>{gmailPermission}</p></details> : null}
      </section>
    </div>
  )
}
