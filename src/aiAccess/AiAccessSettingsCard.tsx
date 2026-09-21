import { useAiAccess } from './AiAccessContext.js'
import { useUiLanguage } from '../uiLanguage.js'
import '../cloud/cloudSettings.css'

export default function AiAccessSettingsCard() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const ai = useAiAccess()
  const automation = ai.gmailAutomation
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
          <div className="eyebrow">CHATGPT · AI ACCESS</div>
          <h2>{zh ? '连接 PJSDAS AI 与后台自动化' : 'Connect PJSDAS AI and background automation'}</h2>
          <p>{zh
            ? 'Google Drive appDataFolder 仍是 PJSDAS 的私有云工作区。AI 读取和受信任的 Monitor / Gmail 摄入都只能通过受限接口写入来源支撑的事实；Decision Rules、持久偏好、删除、主动放弃岗位等用户决策不会被静默修改，仍必须走可审阅的 ChangeSet。'
            : 'Google Drive appDataFolder remains the private PJSDAS cloud workspace. AI reads and trusted Monitor/Gmail ingestion may only write bounded source-backed facts through validated interfaces; user decisions such as Decision Rules, durable preferences, deletions, and abandoning an opportunity still require a reviewable ChangeSet.'}</p>
        </div>
        <span className={`cloud-state ${ai.error ? 'warning' : ai.message || automation?.gmailEnabled || automation?.discoveryEnabled ? 'online' : ''}`}>
          {ai.error ? (zh ? '需要处理' : 'Needs attention') : ai.message || automation?.gmailEnabled || automation?.discoveryEnabled ? (zh ? '已连接' : 'Connected') : (zh ? '未连接' : 'Not connected')}
        </span>
      </div>

      <div className="cloud-auth-row">
        <div>
          <strong>{zh ? '连接 AI 访问授权' : 'Connect AI access'}</strong>
          <p>{zh
            ? '只申请 Google Drive appDataFolder 权限，用于在网页关闭时读取和同步你的 PJSDAS 工作区；不会申请浏览普通 Google Drive 文件。'
            : 'Requests only Google Drive appDataFolder access so PJSDAS can read and sync your workspace while the site is closed. Normal Google Drive files are not requested.'}</p>
        </div>
        <button className="primary-button" disabled={ai.busy} onClick={() => { void ai.beginGoogleDriveLink() }}>
          {ai.busy ? (zh ? '处理中…' : 'Working…') : (zh ? '使用 Google 连接 AI' : 'Connect AI with Google')}
        </button>
      </div>

      <div className="cloud-auth-row">
        <div>
          <strong>{zh ? '后台岗位发现' : 'Background job discovery'}</strong>
          <p>{zh
            ? '启用后，PJSDAS 会按你的 Discovery Profile、Decision Rules 和增量基线在后台检索公开招聘信息，并通过现有 ingestion ledger 去重、过滤和归并。只向搜索模型发送有界的岗位发现上下文，不发送完整 Drive 工作区、Gmail 正文或无关个人数据；关闭后后台公开网页搜索立即停止。'
            : 'When enabled, PJSDAS searches current public recruiting information in the background using your Discovery Profile, Decision Rules, and incremental baseline, then reuses the existing ingestion ledger for filtering, deduplication, and merging. Only bounded job-discovery context is sent to the search model—not the full Drive workspace, Gmail bodies, or unrelated personal data. Disabling this stops background public-web search.'}</p>
          {automation?.discoveryLastSuccessAt ? <small className="cloud-security-note">
            {zh ? `最近成功发现：${new Date(automation.discoveryLastSuccessAt).toLocaleString()}` : `Last successful discovery: ${new Date(automation.discoveryLastSuccessAt).toLocaleString()}`}
          </small> : null}
          {automation?.discoveryLastError ? <div className="cloud-error">{automation.discoveryLastError}</div> : null}
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
            : 'By enabling, you consent to read-only backfill of the last 90 days, including archived mail and excluding spam/trash, followed by periodic checks for new recruiting mail. PJSDAS stores necessary recruiting facts, times, locations and meeting links, but no raw bodies; it does not read attachments or linked pages, or send/change mail. Existing connections keep their previous scope until disabled and explicitly enabled again.'}</p>
          {automation?.gmailLastSuccessAt ? <small className="cloud-security-note">
            {zh ? `最近成功检查：${new Date(automation.gmailLastSuccessAt).toLocaleString()}` : `Last successful check: ${new Date(automation.gmailLastSuccessAt).toLocaleString()}`}
          </small> : null}
          {automation?.gmailLastError ? <div className="cloud-error">{automation.gmailLastError}</div> : null}
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
