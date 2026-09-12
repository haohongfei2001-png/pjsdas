import { useState } from 'react'
import { useUiLanguage } from '../uiLanguage.js'
import { useCloud } from './CloudContext.js'
import AiAccessSettingsCard from '../aiAccess/AiAccessSettingsCard.js'
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
            : cloud.outcome.kind === 'account_mismatch' ? (zh ? 'PJSDAS 账号与本地工作区不匹配' : 'PJSDAS account does not match local workspace')
              : (zh ? '已同步' : 'Synced')

  return (
    <>
      <section className="cloud-settings-card">
        <div className="cloud-settings-heading">
          <div>
            <div className="eyebrow">PJSDAS ACCOUNT & DRIVE · V1.8.1</div>
            <h2>{zh ? 'PJSDAS 账号与 Google Drive 同步' : 'PJSDAS account & Google Drive sync'}</h2>
            <p>{zh
              ? 'Google 登录现在是稳定的 PJSDAS 身份层，会跨刷新和浏览器重开保持。IndexedDB 仍是即时工作区；Google Drive 的隐藏 appDataFolder 只是你的云端副本，PJSDAS 服务器不保存一份求职数据库。'
              : 'Google sign-in is now the durable PJSDAS identity layer and survives refreshes and browser restarts. IndexedDB remains the immediate workspace; the hidden Drive appDataFolder is only your cloud copy, and PJSDAS does not keep a separate job-search database.'}</p>
          </div>
          <span className={`cloud-state ${conflict || mismatch ? 'warning' : user ? 'online' : ''}`}>
            {mismatch
              ? (zh ? '账号不匹配' : 'Account mismatch')
              : conflict
                ? (zh ? '同步冲突' : 'Sync conflict')
                : user
                  ? (zh ? '已登录' : 'Signed in')
                  : cloud.loading
                    ? (zh ? '正在恢复登录…' : 'Restoring session…')
                    : (zh ? '仅本机' : 'Local only')}
          </span>
        </div>

        {!user ? (
          <div className="cloud-auth-row">
            <div>
              <strong>{zh ? '使用 Google 登录 PJSDAS' : 'Sign in to PJSDAS with Google'}</strong>
              <p>{zh
                ? '首次登录会同时申请 openid/profile/email 与 drive.appdata，并建立可持续的 Drive 授权。之后刷新页面或重新打开浏览器，不应要求你再次登录。PJSDAS 不能浏览普通 Google Drive 文件。'
                : 'The first sign-in requests openid/profile/email plus drive.appdata and creates durable Drive authorization. Refreshing or reopening the browser should not require another sign-in. PJSDAS cannot browse normal Drive files.'}</p>
            </div>
            <button className="primary-button" disabled={cloud.loading || cloud.syncing} onClick={() => { void run(cloud.signIn) }}>
              {cloud.loading ? (zh ? '正在恢复…' : 'Restoring…') : (zh ? '使用 Google 登录' : 'Sign in with Google')}
            </button>
          </div>
        ) : (
          <>
            <div className="cloud-account-row">
              <div>
                <span>{zh ? 'PJSDAS 账号' : 'PJSDAS account'}</span>
                <strong>{user.user_metadata?.full_name || user.email || user.id}</strong>
                {user.email ? <small>{user.email}</small> : null}
              </div>
              <div>
                <span>{zh ? '最后同步' : 'Last sync'}</span>
                <strong>{formatTime(cloud.checkpoint.lastSyncedAt, zh)}</strong>
                <small>{cloud.checkpoint.lastSyncedVersion ? `Drive version ${cloud.checkpoint.lastSyncedVersion}` : '—'}</small>
              </div>
              <div>
                <span>{zh ? '当前工作区' : 'Workspace'}</span>
                <strong>{zh ? '本机 IndexedDB' : 'Local IndexedDB'}</strong>
                <small>{cloud.device.deviceId.slice(0, 8)} · local-first</small>
              </div>
            </div>

            {mismatch ? (
              <div className="cloud-conflict-box">
                <strong>{zh ? '为避免跨账号上传，自动同步已暂停。' : 'Auto-sync is paused to prevent cross-account uploads.'}</strong>
                <p>{zh
                  ? '这个浏览器里的本地工作区已经绑定过另一个 Google 身份。PJSDAS 不会自动把那份求职数据上传到当前账号。'
                  : 'The local workspace in this browser is already bound to another Google identity. PJSDAS will not upload that job-search data into the current account automatically.'}</p>
                <div>
                  <button onClick={() => {
                    if (window.confirm(zh ? '确认把当前本地工作区重新绑定到这个 PJSDAS 账号？如果该账号已有 Drive 数据，系统会先进入冲突处理，不会直接覆盖。' : 'Rebind the current local workspace to this PJSDAS account? Existing Drive data will trigger conflict handling rather than being overwritten.')) void run(cloud.rebindLocal)
                  }}>{zh ? '绑定当前本地工作区' : 'Bind current local workspace'}</button>
                  <button className="danger" onClick={() => {
                    if (window.confirm(zh ? '确认用当前账号的 Drive 工作区替换本机工作区？本机尚未同步的修改会丢失。' : 'Replace this device workspace with the current account Drive workspace? Unsynced local changes will be lost.')) void run(cloud.useCloud)
                  }}>{zh ? '使用此账号的 Drive 数据' : 'Use this account’s Drive data'}</button>
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
              <label>
                <input type="checkbox" checked={cloud.device.autoSync} onChange={(event) => cloud.setAutoSync(event.target.checked)} />
                <span>{zh ? '自动同步（登录状态下约每 2 分钟及重新聚焦时检查）' : 'Auto-sync (roughly every 2 minutes and on refocus while signed in)'}</span>
              </label>
              <div>
                <button disabled={cloud.syncing || mismatch || Boolean(conflict)} onClick={() => { void run(async () => cloud.syncNow()) }}>{cloud.syncing ? (zh ? '同步中…' : 'Syncing…') : (zh ? '立即同步' : 'Sync now')}</button>
                <button onClick={() => { void run(cloud.signOut) }}>{zh ? '退出 PJSDAS' : 'Sign out of PJSDAS'}</button>
              </div>
            </div>
            {outcomeLabel ? <div className="cloud-result">{outcomeLabel}</div> : null}
          </>
        )}

        {(localError || cloud.error || cloud.checkpoint.lastError) ? <div className="cloud-error">{localError || cloud.error || cloud.checkpoint.lastError}</div> : null}
        <small className="cloud-security-note">{zh
          ? 'Supabase 只持久化 PJSDAS 登录会话；Google refresh token 在服务端加密保存。浏览器只在内存中缓存短期 Drive access token，过期后会用仍有效的 PJSDAS 登录自动恢复。退出账号不会删除本机 IndexedDB 数据。'
          : 'Supabase persists only the PJSDAS sign-in session; the Google refresh token is encrypted server-side. The browser caches only a short-lived Drive access token in memory and restores it using the active PJSDAS session. Signing out does not delete local IndexedDB data.'}</small>
      </section>
      <AiAccessSettingsCard />
    </>
  )
}
