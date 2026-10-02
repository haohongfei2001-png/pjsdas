import { discoveryReadinessLabel } from '../discoveryReadiness.js'
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
  const discoveryState = discoveryReadinessLabel({ verified: ai.statusVerified, enabled: automation?.discoveryEnabled, readiness: automation?.discoveryReadiness }, zh)
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
    ? '开关开启不代表已经搜索：还需明确保存岗位发现偏好，并单独批准可计量的 TA 搜索预算。条件未满足时不调用付费模型；HCLA 等其他项目预算不能用于此处。条件满足后，TodayAction 按你的岗位偏好和决策规则检索公开招聘信息，避免重复加入。搜索模型只收到有限的岗位发现条件，不会收到完整工作区、Gmail 正文或无关个人资料；关闭后停止后台公开网页搜索。'
    : 'An enabled switch does not mean searches are running. Saved discovery preferences and a separately approved, metered TodayAction budget are required; other projects’ budgets do not apply. Until then paid model calls are blocked. Once ready, TodayAction searches public job information using your preferences and decision rules, without adding duplicates. The search model receives only bounded discovery criteria, never your full workspace, Gmail bodies, or unrelated personal data. Turning this off stops background public-web search.'
  const sourceState = (enabled: boolean | undefined, error: string | null | undefined) => !automation || !ai.statusVerified
    ? (zh ? '状态待核对' : 'Status unverified')
    : enabled && error ? (zh ? '已启用 · 需要处理' : 'Enabled · Needs attention')
      : enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '未启用' : 'Disabled')
  const result = (source: Source) => ai.errorSource === source && ai.error
    ? <div className="cloud-error" role="alert">{ai.error}</div> : null

  return (
    <div className="cloud-settings-card settings-sources">
      {ai.errorSource === 'status' && ai.error ? <div className="cloud-error" role="alert"><strong>{zh ? '后台来源状态暂时无法核对' : 'Background source status is unavailable'}</strong><details><summary>{zh ? '错误详情' : 'Error details'}</summary><p>{ai.error}</p></details></div> : null}
      <section className="settings-source-panel" aria-labelledby="settings-workspace-heading">
        <header className="settings-source-header">
          <div><h2 id="settings-workspace-heading">{zh ? '后台工作区连接' : 'Background workspace connection'}</h2><p>{automation?.googleEmail || (zh ? '尚未连接' : 'Not connected yet')}</p></div>
          <span className={`cloud-state ${ai.statusVerified && automation?.googleEmail ? 'online' : ''}`}>{!automation || !ai.statusVerified ? (zh ? '状态待核对' : 'Status unverified') : automation.googleEmail ? (zh ? '已连接' : 'Connected') : (zh ? '待连接' : 'Not connected')}</span>
        </header>
        <details className="settings-source-manage"><summary>{zh ? '管理' : 'Manage'}</summary><div className="settings-source-body">
          <p className="settings-permission">{zh ? '只申请 Google Drive 的应用专用文件权限，不会浏览普通 Drive 文件。Google 长期授权信息会加密保存。重新连接将打开 Google 授权页面。' : 'This requests only access to app-specific Google Drive files, not normal Drive files. Long-lived authorization is encrypted. Reconnecting opens the Google consent page.'}</p>
          <button className={automation?.googleEmail ? 'settings-quiet-button' : 'primary-button'} disabled={ai.busy} onClick={() => run('workspace', ai.beginGoogleDriveLink)}>{ai.busy && actionSource === 'workspace' ? (zh ? '处理中…' : 'Working…') : automation?.googleEmail ? (zh ? '重新连接' : 'Reconnect') : (zh ? '使用 Google 连接' : 'Connect with Google')}</button>
          <details className="settings-scope-details"><summary>{zh ? '后台工作方式与写入边界' : 'Background operation and write boundaries'}</summary><p>{zh ? '网页关闭后，已授权的来源仍可带来新的岗位和招聘进展。AI 读取与受信任的岗位发现、招聘邮件摄入只能加入有来源依据的有限事实；修改长期偏好、拒绝决定或删除资料仍需你审阅确认。每项来源都能单独关闭。新进展须经过来源、身份、重复项和冲突检查，才会写入工作区。' : 'Authorized sources can bring in new opportunities and recruiting progress while this page is closed. AI reading and trusted discovery or recruiting-email intake may add only bounded, source-backed facts; changes to durable preferences, rejection decisions, or deletions still require your review. Each source can be turned off. New progress is checked for source, identity, duplicates, and conflicts before it enters your workspace.'}</p></details>
        </div></details>
        {ai.message ? <div className="cloud-result" role="status">{ai.message}</div> : null}
        {result('workspace')}
      </section>

      <section className="settings-source-panel" aria-labelledby="settings-discovery-heading">
        <header className="settings-source-header"><div><h2 id="settings-discovery-heading">{zh ? '后台岗位发现' : 'Background job discovery'}</h2><p className={automation?.discoveryEnabled && automation.discoveryLastError ? 'settings-short-warning' : ''} role={automation?.discoveryEnabled && automation.discoveryLastError ? 'status' : undefined}>{automation?.discoveryEnabled && automation.discoveryLastError ? (zh ? '新岗位可能延迟出现' : 'New opportunities may be delayed') : automation?.discoveryLastSuccessAt ? `${zh ? '历史已提交发现：' : 'Last committed discovery: '}${new Date(automation.discoveryLastSuccessAt).toLocaleString()}` : (zh ? '尚无已提交发现；定时检查不代表已搜索' : 'No committed discovery; a scheduler check is not a search')}</p></div>
          <span className={`cloud-state ${ai.statusVerified && automation?.discoveryEnabled ? 'warning' : ''}`}>{discoveryState}</span></header>
        <details className="settings-source-manage"><summary>{zh ? '管理' : 'Manage'}</summary><div className="settings-source-body">
          <p className="settings-permission">{discoveryPermission}</p>
          <button className={automation?.discoveryEnabled ? 'settings-quiet-button' : 'primary-button'} disabled={ai.busy} onClick={() => run('discovery', () => ai.setDiscoveryAutomationEnabled(!automation?.discoveryEnabled))}>{ai.busy && actionSource === 'discovery' ? (zh ? '处理中…' : 'Working…') : discoveryButton}</button>
          {automation?.discoveryLastError ? <details className="settings-scope-details"><summary>{zh ? '错误详情' : 'Error details'}</summary><p>{automation.discoveryLastError}</p></details> : null}
        </div></details>

        {result('discovery')}
      </section>

      <section className="settings-source-panel" aria-labelledby="settings-gmail-heading">
        <header className="settings-source-header"><div><h2 id="settings-gmail-heading">{zh ? '招聘邮件自动跟踪' : 'Automatic recruiting-email tracking'}</h2><GmailIntakeStatus zh={zh} enabled={ai.statusVerified && automation ? automation.gmailEnabled : undefined} lastSuccessAt={automation?.gmailLastSuccessAt ?? undefined} lastError={automation?.gmailLastError ?? undefined} /></div>
          <span className={`cloud-state ${ai.statusVerified && automation?.gmailEnabled ? automation.gmailLastError ? 'warning' : 'online' : ''}`}>{sourceState(automation?.gmailEnabled, automation?.gmailLastError)}</span></header>
        <details className="settings-source-manage"><summary>{zh ? '管理' : 'Manage'}</summary><div className="settings-source-body">
          <p className="settings-permission">{gmailPermission}</p>
          {automation?.gmailEnabled && automation.gmailLastError ? <><p>{zh ? '重新授权会再次请求上方说明的 90 天 Gmail 只读范围；请先查看 Google 同意页面。' : 'Reauthorizing requests the 90-day Gmail read-only scope described above again; review the Google consent screen first.'}</p><button type="button" className="primary-button" disabled={ai.busy} onClick={() => run('gmail', ai.beginGmailAutomationLink)}>{zh ? '查看并重新授权 Gmail' : 'Review and reauthorize Gmail'}</button></> : null}
          <button className={automation?.gmailEnabled ? 'settings-quiet-button' : 'primary-button'} disabled={ai.busy} onClick={() => run('gmail', () => ai.setGmailAutomationEnabled(!automation?.gmailEnabled))}>{ai.busy && actionSource === 'gmail' ? (zh ? '处理中…' : 'Working…') : gmailButton}</button>
          {automation?.gmailLastError ? <details className="settings-scope-details"><summary>{zh ? '错误详情' : 'Error details'}</summary><p>{automation.gmailLastError}</p></details> : null}
        </div></details>

        {result('gmail')}
      </section>
    </div>
  )
}
