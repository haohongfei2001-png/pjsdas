import { useAiAccess } from './AiAccessContext.js'
import { useUiLanguage } from '../uiLanguage.js'
import '../cloud/cloudSettings.css'

export default function AiAccessSettingsCard() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const ai = useAiAccess()
  const automation = ai.gmailAutomation
  const sourceNeedsAttention = Boolean((automation?.gmailEnabled && automation.gmailLastError) || (automation?.discoveryEnabled && automation.discoveryLastError))
  const gmailButton = automation?.gmailEnabled
    ? (zh ? '关闭自动跟踪' : 'Disable tracking')
    : automation?.gmailScopeGranted
      ? (zh ? '启用自动跟踪' : 'Enable tracking')
      : (zh ? '授权 Gmail 并启用' : 'Authorize Gmail and enable')
  const discoveryButton = automation?.discoveryEnabled
    ? (zh ? '关闭后台发现' : 'Disable discovery')
    : (zh ? '启用后台发现' : 'Enable discovery')

  return (
    <section className="cloud-settings-card">
      <div className="cloud-settings-heading">
        <div>
          <div className="eyebrow">BACKGROUND SOURCES</div>
          <h2>{zh ? '后台来源与 AI 连接' : 'Background sources and AI connection'}</h2>
          <p>{zh
            ? '网页关闭后，已授权的来源仍可带来新的岗位和招聘进展。每项来源都能单独关闭；系统不会替你悄悄改变决策规则、删除资料或放弃岗位。'
            : 'Authorized sources can bring in new opportunities and recruiting progress while this page is closed. You can turn each source off; they cannot silently change your decision rules, delete data, or abandon an opportunity.'}</p>
        </div>
        <span className={`cloud-state ${ai.error || sourceNeedsAttention ? 'warning' : ai.message || automation?.gmailEnabled || automation?.discoveryEnabled ? 'online' : ''}`}>
          {ai.error || sourceNeedsAttention ? (zh ? '需要处理' : 'Needs attention') : ai.message || automation?.gmailEnabled || automation?.discoveryEnabled ? (zh ? '已连接' : 'Connected') : (zh ? '未连接' : 'Not connected')}
        </span>
      </div>

      <div className="cloud-auth-row">
        <div>
          <strong>{zh ? '连接后台工作区' : 'Connect background workspace'}</strong>
          <p>{zh
            ? '授权后，网页关闭时仍可同步你的 PJSDAS 工作区。只申请 Google Drive 的应用专用文件权限，不会浏览普通 Drive 文件。'
            : 'This lets PJSDAS sync your workspace while the page is closed. It requests only access to its app-specific Google Drive files, not your normal Drive files.'}</p>
        </div>
        <button className="primary-button" disabled={ai.busy} onClick={() => { void ai.beginGoogleDriveLink() }}>
          {ai.busy ? (zh ? '处理中…' : 'Working…') : (zh ? '使用 Google 连接 AI' : 'Connect AI with Google')}
        </button>
      </div>

      <div className="cloud-auth-row">
        <div>
          <strong>{zh ? '后台岗位发现' : 'Background job discovery'}</strong>
          <p>{zh
            ? '启用后，PJSDAS 按你的岗位偏好和决策规则检索公开招聘信息，避免重复加入。搜索模型只收到有限的岗位发现条件，不会收到完整工作区、Gmail 正文或无关个人资料；关闭后停止后台公开网页搜索。'
            : 'When enabled, PJSDAS searches public job information using your preferences and decision rules, without adding duplicates. The search model receives only bounded discovery criteria, never your full workspace, Gmail bodies, or unrelated personal data. Turning this off stops background public-web search.'}</p>
          {automation?.discoveryLastSuccessAt ? <small className="cloud-security-note">
            {zh ? `最近成功发现：${new Date(automation.discoveryLastSuccessAt).toLocaleString()}` : `Last successful discovery: ${new Date(automation.discoveryLastSuccessAt).toLocaleString()}`}
          </small> : null}
          {automation?.discoveryEnabled && automation.discoveryLastError ? <div className="cloud-connection-impact warning" role="status"><strong>{zh ? '新岗位可能延迟出现' : 'New opportunities may be delayed'}</strong><span>{zh ? '最近一次后台发现失败。已保存的岗位仍可用；检查连接状态后再试。' : 'The latest background search failed. Saved opportunities remain available; check the connection before trying again.'}</span><details><summary>{zh ? '错误详情' : 'Error details'}</summary>{automation.discoveryLastError}</details></div> : null}
        </div>
        <button
          className="primary-button"
          disabled={ai.busy}
          onClick={() => { void ai.setDiscoveryAutomationEnabled(!automation?.discoveryEnabled) }}
        >
          {ai.busy ? (zh ? '处理中…' : 'Working…') : discoveryButton}
        </button>
      </div>

      <div className="cloud-auth-row">
        <div>
          <strong>{zh ? '招聘邮件自动跟踪' : 'Automatic recruiting-email tracking'}</strong>
          <p>{zh
            ? '点击启用即同意：以 Gmail 只读权限回补最近90天邮件（含已归档、不含垃圾箱/垃圾邮件），以后定期读取新增招聘邮件，并保存必要的公司、岗位、招聘进展、时间、地点与会议链接。原始正文不保存，附件和链接页面不读取；不发送或修改邮件。已有连接不会自动扩大范围，关闭后重新启用才采用上述范围。'
            : 'By enabling Gmail read-only access, you consent to backfill of the last 90 days, including archived mail and excluding spam/trash, followed by periodic checks for new recruiting mail. PJSDAS stores necessary recruiting facts, times, locations and meeting links, but no raw bodies. Raw email bodies are never persisted in PJSDAS; ambiguous messages remain unresolved. It does not read attachments or linked pages, or send/change mail. Existing connections keep their previous scope until disabled and explicitly enabled again.'}</p>
          {automation?.gmailLastSuccessAt ? <small className="cloud-security-note">
            {zh ? `最近成功检查：${new Date(automation.gmailLastSuccessAt).toLocaleString()}` : `Last successful check: ${new Date(automation.gmailLastSuccessAt).toLocaleString()}`}
          </small> : null}
          {automation?.gmailEnabled && automation.gmailLastError ? <div className="cloud-connection-impact warning" role="status"><strong>{zh ? '新邮件进展可能未同步' : 'New email progress may be missing'}</strong><span>{zh ? '最近一次邮件检查失败，已有资料仍可查看。重新授权会再次请求上方说明的 90 天 Gmail 只读范围；请先查看 Google 同意页面。' : 'The latest email check failed; saved data remains available. Reauthorizing requests the 90-day Gmail read-only scope described above again; review the Google consent screen first.'}</span><details><summary>{zh ? '错误详情' : 'Error details'}</summary>{automation.gmailLastError}</details><button type="button" disabled={ai.busy} onClick={() => { void ai.beginGmailAutomationLink() }}>{zh ? '查看并重新授权 Gmail' : 'Review and reauthorize Gmail'}</button></div> : null}
        </div>
        <button
          className="primary-button"
          disabled={ai.busy}
          onClick={() => { void ai.setGmailAutomationEnabled(!automation?.gmailEnabled) }}
        >
          {ai.busy ? (zh ? '处理中…' : 'Working…') : gmailButton}
        </button>
      </div>

      {ai.message ? <div className="cloud-result">{ai.message}</div> : null}
      {ai.error ? <div className="cloud-error">{ai.error}</div> : null}
      <small className="cloud-security-note">{zh
        ? 'Google refresh token 写入前由 PJSDAS 后端使用 AES-GCM 加密。岗位发现与招聘邮件自动化都可在网页关闭时运行；真正写入仍复用 ingestion ledger、身份解析、去重与 optimistic Drive 冲突保护。'
        : 'Google refresh tokens are AES-GCM encrypted by the PJSDAS backend before storage. Job discovery and recruiting-email automation can continue while the site is closed and still reuse the ingestion ledger, identity resolution, deduplication, and optimistic Drive conflict guard.'}</small>
    </section>
  )
}
