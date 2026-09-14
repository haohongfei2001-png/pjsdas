import { useAiAccess } from './AiAccessContext.js'
import { useUiLanguage } from '../uiLanguage.js'
import '../cloud/cloudSettings.css'

export default function AiAccessSettingsCard() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const ai = useAiAccess()

  return (
    <section className="cloud-settings-card">
      <div className="cloud-settings-heading">
        <div>
          <div className="eyebrow">CHATGPT · AI ACCESS</div>
          <h2>{zh ? '为 ChatGPT 启用只读 PJSDAS 数据' : 'Enable read-only PJSDAS data for ChatGPT'}</h2>
          <p>{zh
            ? '这一步会用 Google 登录建立 PJSDAS 身份，并只申请 Google Drive 的 drive.appdata 权限。Google 的持续授权会在服务端加密保存。AI 直连保持只读；如果 ChatGPT 提议修改，必须通过可审阅的 ChangeSet 明确应用，不能静默改写你的求职数据。'
            : 'This signs you into PJSDAS with Google and requests only the Drive appData permission. Long-lived Google authorization is encrypted server-side. Direct AI access remains read-only; any proposed change must come through a reviewable ChangeSet and cannot silently rewrite your job-search data.'}</p>
        </div>
        <span className={`cloud-state ${ai.error ? 'warning' : ai.message ? 'online' : ''}`}>
          {ai.error ? (zh ? '需要处理' : 'Needs attention') : ai.message ? (zh ? '已连接' : 'Connected') : (zh ? '未连接' : 'Not connected')}
        </span>
      </div>

      <div className="cloud-auth-row">
        <div>
          <strong>{zh ? '连接 AI 读取授权' : 'Connect AI read access'}</strong>
          <p>{zh
            ? 'Google 会再次显示授权页，因为 ChatGPT 需要在你不打开 PJSDAS 网页时也能读取你自己的 appDataFolder。不会申请浏览普通 Google Drive 文件的权限。'
            : 'Google will show consent again because ChatGPT needs delegated access even when the PJSDAS webpage is closed. Normal Drive files are not requested.'}</p>
        </div>
        <button className="primary-button" disabled={ai.busy} onClick={() => { void ai.beginGoogleDriveLink() }}>
          {ai.busy ? (zh ? '处理中…' : 'Working…') : (zh ? '使用 Google 连接 AI' : 'Connect AI with Google')}
        </button>
      </div>

      {ai.message ? <div className="cloud-result">{ai.message}</div> : null}
      {ai.error ? <div className="cloud-error">{ai.error}</div> : null}
      <small className="cloud-security-note">{zh
        ? '浏览器中的本次授权建立流程只在当前标签页保留临时状态；Google refresh token 写入前由 PJSDAS 后端使用 AES-GCM 加密。日常 PJSDAS 登录会话与这段一次性授权状态相互独立。'
        : 'The authorization setup flow keeps only temporary state in the current tab. The Google refresh token is AES-GCM encrypted by the PJSDAS backend before storage. Your normal PJSDAS sign-in session is separate from this one-time setup state.'}</small>
    </section>
  )
}
