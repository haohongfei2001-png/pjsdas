import { useState } from 'react'
import { useUiLanguage } from '../uiLanguage'
import { useCloud } from './CloudContext'
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
    : cloud.outcome.kind === 'created' ? (zh ? '已创建云端工作区' : 'Cloud workspace created')
      : cloud.outcome.kind === 'pushed' ? (zh ? '本地修改已上传' : 'Local changes uploaded')
        : cloud.outcome.kind === 'pulled' ? (zh ? '已拉取云端修改' : 'Cloud changes downloaded')
          : cloud.outcome.kind === 'conflict' ? (zh ? '检测到同步冲突' : 'Sync conflict detected')
            : cloud.outcome.kind === 'account_mismatch' ? (zh ? '账号与本地工作区不匹配' : 'Account does not match local workspace')
              : (zh ? '已同步' : 'Synced')

  return (
    <section className="cloud-settings-card">
      <div className="cloud-settings-heading">
        <div>
          <div className="eyebrow">ACCOUNT & CLOUD · V1.0</div>
          <h2>{zh ? '账号与云端同步' : 'Account & cloud sync'}</h2>
          <p>{zh
            ? 'IndexedDB 仍是即时工作区。登录后云端保存账号隔离的加密传输快照，并用 revision 检测多设备冲突；系统不会静默覆盖双端修改。'
            : 'IndexedDB remains the immediate workspace. After sign-in, the cloud stores an account-isolated snapshot over encrypted transport and uses revisions to detect multi-device conflicts; concurrent edits are never silently overwritten.'}</p>
        </div>
        <span className={`cloud-state ${conflict || mismatch ? 'warning' : user ? 'online' : ''}`}>
          {!cloud.configured
            ? (zh ? '未配置' : 'Not configured')
            : mismatch
              ? (zh ? '账号不匹配' : 'Account mismatch')
              : conflict
                ? (zh ? '冲突' : 'Conflict')
                : user
                  ? (zh ? '已登录' : 'Signed in')
                  : (zh ? '仅本地' : 'Local only')}
        </span>
      </div>

      {!cloud.configured ? (
        <div className="cloud-setup-note">
          <strong>{zh ? '云端代码已就绪，但当前部署没有连接云项目。' : 'Cloud code is ready, but this deployment is not connected to a cloud project.'}</strong>
          <p>{zh
            ? '创建 Supabase 项目并配置 Google OAuth 后，在 GitHub Actions Variables 中设置 VITE_SUPABASE_URL 和 VITE_SUPABASE_PUBLISHABLE_KEY 即可启用。未配置时所有现有功能继续纯本地运行。'
            : 'Create a Supabase project, configure Google OAuth, then set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY as GitHub Actions variables. Until then, every existing feature continues to run locally.'}</p>
        </div>
      ) : !user ? (
        <div className="cloud-auth-row">
          <div><strong>{zh ? '使用 Google 账号登录' : 'Sign in with Google'}</strong><p>{zh ? '登录只用于识别你的 PJSDAS 云工作区。' : 'Sign-in is used to identify your private PJSDAS cloud workspace.'}</p></div>
          <button className="primary-button" disabled={cloud.loading || cloud.syncing} onClick={() => { void run(cloud.signIn) }}>{zh ? '使用 Google 登录' : 'Sign in with Google'}</button>
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
              <small>{cloud.checkpoint.lastSyncedRevision ? `revision ${cloud.checkpoint.lastSyncedRevision}` : '—'}</small>
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
                ? '这个浏览器里的本地工作区已经绑定过另一个账号。PJSDAS 不会自动把那份求职数据上传到当前账号。'
                : 'The local workspace in this browser is already bound to another account. PJSDAS will not upload that job-search data into the current account automatically.'}</p>
              <div>
                <button onClick={() => {
                  if (window.confirm(zh ? '确认把当前本地工作区重新绑定到这个账号？如果此账号已有云端数据，系统会先进入冲突处理，不会直接覆盖。' : 'Rebind the current local workspace to this account? Existing cloud data will trigger conflict handling rather than being overwritten.')) void run(cloud.rebindLocal)
                }}>{zh ? '绑定当前本地工作区' : 'Bind current local workspace'}</button>
                <button className="danger" onClick={() => {
                  if (window.confirm(zh ? '确认用当前账号的云端工作区替换本机工作区？本机尚未同步的修改会丢失。' : 'Replace this device workspace with this account’s cloud workspace? Unsynced local changes will be lost.')) void run(cloud.useCloud)
                }}>{zh ? '切换到此账号云端数据' : 'Use this account’s cloud data'}</button>
              </div>
            </div>
          ) : conflict ? (
            <div className="cloud-conflict-box">
              <strong>{zh ? '本机和云端在上次同步后都发生了修改。' : 'Both this device and the cloud changed after the last sync.'}</strong>
              <p>{zh ? `云端 revision ${conflict.remoteRevision}，更新时间 ${formatTime(conflict.remoteUpdatedAt, zh)}。系统已停止自动同步，没有覆盖任何一方。` : `Cloud revision ${conflict.remoteRevision}, updated ${formatTime(conflict.remoteUpdatedAt, zh)}. Auto-sync stopped and neither side was overwritten.`}</p>
              <div>
                <button onClick={() => {
                  if (window.confirm(zh ? '确认以本机数据为准覆盖云端？' : 'Keep this device and overwrite the cloud version?')) void run(cloud.keepLocal)
                }}>{zh ? '保留本机' : 'Keep this device'}</button>
                <button className="danger" onClick={() => {
                  if (window.confirm(zh ? '确认以云端数据为准替换本机？本机未同步修改会丢失。' : 'Use the cloud version and replace local data? Unsynced local changes will be lost.')) void run(cloud.useCloud)
                }}>{zh ? '使用云端' : 'Use cloud'}</button>
              </div>
            </div>
          ) : null}

          <div className="cloud-controls">
            <label><input type="checkbox" checked={cloud.device.autoSync} onChange={(event) => cloud.setAutoSync(event.target.checked)} /> <span>{zh ? '自动同步（约每分钟及重新聚焦时检查）' : 'Auto-sync (roughly every minute and on refocus)'}</span></label>
            <div>
              <button disabled={cloud.syncing || mismatch || Boolean(conflict)} onClick={() => { void run(async () => cloud.syncNow()) }}>{cloud.syncing ? (zh ? '同步中…' : 'Syncing…') : (zh ? '立即同步' : 'Sync now')}</button>
              <button onClick={() => { void run(cloud.signOut) }}>{zh ? '退出登录' : 'Sign out'}</button>
            </div>
          </div>
          {outcomeLabel ? <div className="cloud-result">{outcomeLabel}</div> : null}
        </>
      )}

      {(localError || cloud.error || cloud.checkpoint.lastError) ? <div className="cloud-error">{localError || cloud.error || cloud.checkpoint.lastError}</div> : null}
      <small className="cloud-security-note">{zh ? '云端只使用浏览器可公开的 Supabase Publishable Key；不要把 service_role key 放进前端或 GitHub Pages。' : 'The browser uses only the public Supabase Publishable Key. Never place a service_role key in the frontend or GitHub Pages.'}</small>
    </section>
  )
}
