import { useAiAccess } from './AiAccessContext.js'
import { useUiLanguage } from '../uiLanguage.js'
import '../cloud/cloudSettings.css'

export default function AiAccessSettingsCard() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const ai = useAiAccess()
  const gmail = ai.gmailAutomation
  const gmailButton = gmail?.gmailEnabled
    ? (zh ? '关闭自动跟踪' : 'Disable tracking')
    : gmail?.gmailScopeGranted
      ? (zh ? '启用自动跟踪' : 'Enable tracking')
      : (zh ? '授权 Gmail 并启用' : 'Authorize Gmail and enable')

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
        <span className={`cloud-state ${ai.error ? 'warning' : ai.message || gmail?.gmailEnabled ? 'online' : ''}`}>
          {ai.error ? (zh ? '需要处理' : 'Needs attention') : ai.message || gmail?.gmailEnabled ? (zh ? '已连接' : 'Connected') : (zh ? '未连接' : 'Not connected')}
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
          <strong>{zh ? '招聘邮件自动跟踪' : 'Automatic recruiting-email tracking'}</strong>
          <p>{zh
            ? '启用后，PJSDAS 后台只申请 Gmail 只读权限，定期读取新增招聘邮件，在内存中抽取公司、岗位、笔试、面试、Offer、拒信和时间等结构化事实。原始邮件正文不会写入 PJSDAS；歧义内容会进入 unresolved，不会猜着更新。'
            : 'When enabled, PJSDAS requests Gmail read-only access and periodically extracts bounded recruiting facts such as company, role, assessments, interviews, offers, rejections, and timing. Raw email bodies are never persisted in PJSDAS; ambiguous messages remain unresolved instead of being guessed.'}</p>
          {gmail?.gmailLastSuccessAt ? <small className="cloud-security-note">
            {zh ? `最近成功检查：${new Date(gmail.gmailLastSuccessAt).toLocaleString()}` : `Last successful check: ${new Date(gmail.gmailLastSuccessAt).toLocaleString()}`}
          </small> : null}
          {gmail?.gmailLastError ? <div className="cloud-error">{gmail.gmailLastError}</div> : null}
        </div>
        <button
          className="primary-button"
          disabled={ai.busy}
          onClick={() => { void ai.setGmailAutomationEnabled(!gmail?.gmailEnabled) }}
        >
          {ai.busy ? (zh ? '处理中…' : 'Working…') : gmailButton}
        </button>
      </div>

      {ai.message ? <div className="cloud-result">{ai.message}</div> : null}
      {ai.error ? <div className="cloud-error">{ai.error}</div> : null}
      <small className="cloud-security-note">{zh
        ? 'Google refresh token 写入前由 PJSDAS 后端使用 AES-GCM 加密。招聘邮件自动化与网页是否打开无关；真正写入仍复用现有 ingestion ledger、去重、身份解析与 optimistic Drive 冲突保护。'
        : 'Google refresh tokens are AES-GCM encrypted by the PJSDAS backend before storage. Recruiting-email automation continues even when the site is closed and still uses the existing ingestion ledger, deduplication, identity resolution, and optimistic Drive conflict guard.'}</small>
    </section>
  )
}
