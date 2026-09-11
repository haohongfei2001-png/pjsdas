import { useState } from 'react'
import { useUiLanguage } from '../uiLanguage'
import { useCloud } from './CloudContext'
import AiAccessSettingsCard from '../aiAccess/AiAccessSettingsCard'
import './cloudSettings.css'

function formatTime(iso: string | undefined, zh: boolean) {
  if (!iso) return zh ? '尚未同步' : 'Not synced yet'
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso))
}

export default function CloudSettingsCard() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const cloud = useCloud()
  const [localError, setLocalError] = useState('')
  const user = cloud.session?.user
  const mismatch = Boolean(user && cloud.device.workspaceOwnerUserId && cloud.device.workspaceOwnerUserId !== user.id)
  const conflict = cloud.checkpoint.conflict

  async function run(action: () => Promise<unknown>) {
    setLocalError('')
    try {
      await action()
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const outcomeLabel = !cloud.outcome
    ? ''
    : cloud.outcome.kind === 'created' ? (zh ? '已在你的 Google Drive 建立 PJSDAS 工作区' : 'PJSDAS workspace created in your Google Drive')
      : cloud.outcome.kind === 'pushed' ? (zh ? '本地修改已同步到 Google Drive' : 'Local changes synced to Google Drive')
        : cloud.outcome.kind === 'pulled' ? (zh ? '已从 Google Drive 拉取修改' : 'Changes downloaded from Google Drive')
          : cloud.outcome.kind === 'conflict' ? (zh ? '检测到同步冲突' : 'Sync conflict detected')
            : cloud.outcome.kind === 'account_mismatch' ? (zh ? 'Google 账号与本地工作区不匹配' : 'Google account does not match local workspace')
              : (zh ? '已同步' : 'Synced')

  return (
    <>
      <section className="cloud-settings-card">
      <div className="cloud-settings-heading">
        <div>
          <div className="eyebrow">GOOGLE DRIVE SYNC · V1.0</div>
          <h2>{zh ? 'Google 账号与云端同步' : 'Google account & Drive sync'}</h2>
          <p>{zh
            ? 'IndexedDB 仍是即时工作区。启用后，PJSDAS 只把自己的工作区快照保存到你 Google Drive 的隐藏 appDataFolder；PJSDAS 不维护一份自己的用户求职数据库。'
            : 'IndexedDB remains the immediate workspace. When enabled, PJSDAS stores only its workspace snapshot in your Google Drive hidden appDataFolder; PJSDAS does not maintain a separate server-side job-search database.'}</p>
        </div>
        <span className={`cloud-state ${conflict || mismatch ? 'warning' : user ? 'online' : ''}`}>
          {!cloud.configured
            ? (zh ? '未配置' : 'Not configured')
            : mismatch
              ? (zh ? '账号不匹配' : 'Account mismatch')
              : conflict
                ? (zh ? '冲突' : 'Conflict')
                : user
                  ? (zh ? '已连接' : 'Connected')
                  : (zh ? '仅本地' : 'Local only')}
        </span>
      </div>

      {!cloud.configured ? (
        <div className="cloud-setup-note">
          <strong>{zh ? 'Google Drive 同步代码已就绪，但当前部署还没有 OAuth Client ID。' : 'Google Drive sync is ready, but this deployment does not have an OAuth Client ID yet.'}</strong>
          <p>{zh
            ? '在 Google Cloud 启用 Drive API、创建 Web OAuth Client，然后在 GitHub Actions Variables 中设置 VITE_GOOGLE_CLIENT_ID 即可。未配置时所有现有功能继续纯本地运行。'
            : 'Enable the Drive API in Google Cloud, create a Web OAuth client, then set VITE_GOOGLE_CLIENT_ID in GitHub Actions Variables. Until then, every existing feature continues to run locally.'}</p>
        </div>
      ) : !user ? (
        <div className="cloud-auth-row">
          <div><strong>{zh ? '连接你的 Google Drive' : 'Connect your Google Drive'}</strong><p>{zh ? '只申请 openid/profile/email 与 drive.appdata；PJSDAS 不能浏览你的普通 Drive 文件。' : 'Only openid/profile/email and drive.appdata are requested; PJSDAS cannot browse your normal Drive files.'}</p></div>
          <button className="primary-button" disabled={cloud.loading || cloud.syncing} onClick={() => { void run(cloud.signIn) }}>{cloud.loading ? (zh ? '连接中…' : 'Connecting…') : (zh ? '使用 Google 账号连接' : 'Connect Google account')}</button>
        </div>
      ) : (
        <>
          <div className="cloud-account-row">
            <div>
              <span>{zh ? '当前账号' : 'Account'}</span>
              <strong>{user.user_metadata?.full_name || user.email || user.id}</strong>
              {user.email ? <small>{user.email}</small> : null}
            </div>
            <div>
              <span>{zh ? '最后同步' : 'Last sync'}</span>
              <strong>{formatTime(cloud.checkpoint.lastSyncedAt, zh)}</strong>
              <small>{cloud.checkpoint.lastSyncedVersion ? `Drive version ${cloud.checkpoint.lastSyncedVersion}` : '—'}</small>
            </div>
            <div>
              <span>{zh ? '本机' : 'Device'}</span>
              <strong>{cloud.device.deviceId.slice(0, 8)}</strong>
              <small>local-first</small>
            </div>
          </div>

          {mismatch ? (
            <div className="cloud-conflict-box">
              <strong>{zh ? '为避免跨账号上传，自动同步已暂停。' : 'Auto-sync is paused to prevent cross-account uploads.'}</strong>
              <p>{zh
                ? '这个浏览器里的本地工作区已经绑定过另一个 Google 账号。PJSDAS 不会自动把那份求职数据上传到当前账号。'
                : 'The local workspace in this browser is already bound to another Google account. PJSDAS will not upload that job-search data into the current account automatically.'}</p>
              <div>
                <button onClick={() => {
                  if (window.confirm(zh ? '确认把当前本地工作区重新绑定到这个 Google 账号？如果该账号已有 Drive 数据，系统会先进入冲突处理，不会直接覆盖。' : 'Rebind the current local workspace to this Google account? Existing Drive data will trigger conflict handling rather than being overwritten.')) void run(cloud.rebindLocal)
                }}>{zh ? '绑定当前本地工作区' : 'Bind current local workspace'}</button>
                <button className="danger" onClick={() => {
                  if (window.confirm(zh ? '确认用当前 Google 账号的 Drive 工作区替换本机工作区？本机尚未同步的修改会丢失。' : 'Replace this device workspace with the current Google account Drive workspace? Unsynced local changes will be lost.')) void run(cloud.useCloud)
                }}>{zh ? '切换到此账号 Drive 数据' : 'Use this account’s Drive data'}</button>
              </div>
            </div>
          ) : conflict ? (
            <div className="cloud-conflict-box">
              <strong>{zh ? '本机和 Google Drive 在上次同步后都发生了修改。' : 'Both this device and Google Drive changed after the last sync.'}</strong>
              <p>{zh ? `Drive version ${conflict.remoteVersion}，更新时间 ${formatTime(conflict.remoteUpdatedAt, zh)}。系统已停止自动同步，没有覆盖任何一方。` : `Drive version ${conflict.remoteVersion}, updated ${formatTime(conflict.remoteUpdatedAt, zh)}. Auto-sync stopped and neither side was overwritten.`}</p>
              <div>
                <button onClick={() => {
                  if (window.confirm(zh ? '确认以本机数据为准覆盖 Google Drive 中的 PJSDAS 工作区？' : 'Keep this device and overwrite the PJSDAS workspace in Google Drive?')) void run(cloud.keepLocal)
                }}>{zh ? '保留本机' : 'Keep this device'}</button>
                <button className="danger" onClick={() => {
                  if (window.confirm(zh ? '确认以 Google Drive 数据为准替换本机？本机未同步修改会丢失。' : 'Use the Google Drive version and replace local data? Unsynced local changes will be lost.')) void run(cloud.useCloud)
                }}>{zh ? '使用 Google Drive' : 'Use Google Drive'}</button>
              </div>
            </div>
          ) : null}

          <div className="cloud-controls">
            <label><input type="checkbox" checked={cloud.device.autoSync} onChange={(event) => cloud.setAutoSync(event.target.checked)} /> <span>{zh ? '自动同步（本次 Google 授权有效期间约每 2 分钟及重新聚焦时检查）' : 'Auto-sync (roughly every 2 minutes and on refocus while this Google authorization is active)'}</span></label>
            <div>
              <button disabled={cloud.syncing || mismatch || Boolean(conflict)} onClick={() => { void run(async () => cloud.syncNow()) }}>{cloud.syncing ? (zh ? '同步中…' : 'Syncing…') : (zh ? '立即同步' : 'Sync now')}</button>
              <button onClick={() => { void run(cloud.signOut) }}>{zh ? '断开 Google' : 'Disconnect Google'}</button>
            </div>
          </div>
          {outcomeLabel ? <div className="cloud-result">{outcomeLabel}</div> : null}
        </>
      )}

      {(localError || cloud.error || cloud.checkpoint.lastError) ? <div className="cloud-error">{localError || cloud.error || cloud.checkpoint.lastError}</div> : null}
      <small className="cloud-security-note">{zh ? 'Google Access Token 只保存在当前页面内存中，不写入 IndexedDB 或 localStorage；授权过期只会暂停云同步，本地 PJSDAS 继续可用。' : 'The Google access token is kept only in current-page memory, never IndexedDB or localStorage. Expired authorization pauses cloud sync while local PJSDAS remains usable.'}</small>
      </section>
      <AiAccessSettingsCard />
    </>
  )
}
