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
          <div className="eyebrow">CHATGPT · AI ACCESS · V1.8.1</div>
          <h2>{zh ? '为 ChatGPT 启用只读 PJSDAS 数据' : 'Enable read-only PJSDAS data for ChatGPT'}</h2>
          <p>{zh
            ? 'AI 读取与 PJSDAS 账户共用同一 Google 身份。Google 的持续 Drive 授权仍由服务端加密保存；ChatGPT 只通过现有 MCP 读取你的 appDataFolder，不获得 PJSDAS 的静默写权限。'
            : 'AI access shares the same Google identity as your PJSDAS account. Long-lived Drive authorization remains encrypted server-side; ChatGPT reads your appDataFolder through the existing MCP without silent PJSDAS write access.'}</p>
        </div>
        <span className={`cloud-state ${ai.error ? 'warning' : ai.message ? 'online' : ''}`}>
          {ai.error ? (zh ? '需要处理' : 'Needs attention') : ai.message ? (zh ? '已连接' : 'Connected') : (zh ? '可连接' : 'Available')}
        </span>
      </div>

      <div className="cloud-auth-row">
        <div>
          <strong>{zh ? '确认 AI 读取授权' : 'Confirm AI read access'}</strong>
          <p>{zh
            ? '如果此前已经建立 Google Drive 持续授权，通常不需要反复操作。只有授权失效或需要重新授予 offline access 时，Google 才需要再次确认。'
            : 'If durable Google Drive authorization already exists, repeated setup is normally unnecessary. Google consent is needed again only when authorization expires or offline access must be granted again.'}</p>
        </div>
        <button className="primary-button" disabled={ai.busy} onClick={() => { void ai.beginGoogleDriveLink() }}>
          {ai.busy ? (zh ? '处理中…' : 'Working…') : (zh ? '重新确认 Google 授权' : 'Reconfirm Google access')}
        </button>
      </div>

      {ai.message ? <div className="cloud-result">{ai.message}</div> : null}
      {ai.error ? <div className="cloud-error">{ai.error}</div> : null}
      <small className="cloud-security-note">{zh
        ? 'PJSDAS 账户会话可跨刷新和浏览器重开保持；Google refresh token 在写入前由 Vercel 服务端使用 AES-GCM 加密，浏览器只临时持有短期 Drive access token。'
        : 'The PJSDAS account session survives refreshes and browser restarts. The Google refresh token is AES-GCM encrypted by the Vercel backend; the browser only holds a short-lived Drive access token in memory.'}</small>
    </section>
  )
}
