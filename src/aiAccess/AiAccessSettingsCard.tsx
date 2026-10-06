import { googleConnectionHealth, googleConnectionHealthLabel } from '../googleConnectionHealth.js'
import { discoveryReadinessLabel } from '../discoveryReadiness.js'
import { useEffect, useState } from 'react'
import { useAiAccess } from './AiAccessContext.js'
import { useUiLanguage } from '../uiLanguage.js'
import GmailIntakeStatus from './GmailIntakeStatus.js'
import '../cloud/cloudSettings.css'

type Source = 'discovery' | 'gmail'

export default function AiAccessSettingsCard() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const ai = useAiAccess()
  const automation = ai.gmailAutomation
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const update = () => setNow(Date.now())
    const timer = window.setInterval(update, 120_000)
    window.addEventListener('focus', update)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update) }
  }, [])
  const gmailHealth = googleConnectionHealth({ verified: ai.statusVerified, enabled: automation?.gmailEnabled, lastError: automation?.gmailLastError, lastSuccessAt: automation?.gmailLastSuccessAt, now })
  const discoveryState = discoveryReadinessLabel({ verified: ai.statusVerified, enabled: automation?.discoveryEnabled, readiness: automation?.discoveryReadiness }, zh)
  const [actionSource, setActionSource] = useState<Source>('discovery')
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
  const result = (source: Source) => ai.errorSource === source && ai.error
    ? <div className="cloud-error" role="alert">{ai.error}</div> : null

  return (
    <div className="cloud-settings-card settings-sources">
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
        <header className="settings-source-header"><div><h2 id="settings-gmail-heading">{zh ? '招聘邮件自动跟踪' : 'Automatic recruiting-email tracking'}</h2><GmailIntakeStatus zh={zh} enabled={ai.statusVerified && automation ? automation.gmailEnabled : undefined} lastSuccessAt={automation?.gmailLastSuccessAt ?? undefined} lastCheckedAt={automation?.gmailLastCheckedAt ?? undefined} lastError={automation?.gmailLastError ?? undefined} /></div>
          <span className={`cloud-state ${ai.statusVerified && automation?.gmailEnabled ? gmailHealth === 'current' ? 'online' : 'warning' : ''}`}>{googleConnectionHealthLabel(gmailHealth, zh)}</span></header>
        <details className="settings-source-manage"><summary>{zh ? '管理' : 'Manage'}</summary><div className="settings-source-body">
          <p className="settings-permission">{gmailPermission}</p>
          {gmailHealth === 'reconnect_required' ? <><p>{zh ? '重新授权会再次请求上方说明的 90 天 Gmail 只读范围；请先查看 Google 同意页面。' : 'Reauthorizing requests the 90-day Gmail read-only scope described above again; review the Google consent screen first.'}</p><button type="button" className="primary-button" disabled={ai.busy} onClick={() => run('gmail', ai.beginGmailAutomationLink)}>{zh ? '查看并重新授权 Gmail' : 'Review and reauthorize Gmail'}</button></> : null}
          <button className={automation?.gmailEnabled ? 'settings-quiet-button' : 'primary-button'} disabled={ai.busy} onClick={() => run('gmail', () => ai.setGmailAutomationEnabled(!automation?.gmailEnabled))}>{ai.busy && actionSource === 'gmail' ? (zh ? '处理中…' : 'Working…') : gmailButton}</button>
          {automation?.gmailLastError ? <details className="settings-scope-details"><summary>{zh ? '错误详情' : 'Error details'}</summary><p>{automation.gmailLastError}</p></details> : null}
        </div></details>

        {result('gmail')}
      </section>
    </div>
  )
}
