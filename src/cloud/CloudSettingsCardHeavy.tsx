import { useEffect, useState } from 'react'
import { useUiLanguage } from '../uiLanguage.js'
import { useCloud } from './CloudContext.js'
import { connectedWorkspaceAuthorityEnabled } from './connectedWorkspaceRepository.js'
import AiAccessSettingsCard from '../aiAccess/AiAccessSettingsCard.js'
import { fetchAudienceStatus, type AudienceStatus } from '../audienceAccessClient.js'
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
  const [audience, setAudience] = useState<AudienceStatus>()
  const user = cloud.session?.user
  const mismatch = Boolean(user && cloud.device.workspaceOwnerUserId && cloud.device.workspaceOwnerUserId !== user.id)
  const conflict = cloud.checkpoint.conflict
  const transactional = connectedWorkspaceAuthorityEnabled()
  const remoteLabel = transactional ? (zh ? '账号工作区' : 'account workspace') : 'Google Drive'
  const connectionError = localError || cloud.error || cloud.checkpoint.lastError
  const impact = mismatch
    ? (zh ? '这个浏览器仍保留另一个账号的本地资料。为避免跨账号写入，当前账号不会接收这些修改；请先选择恢复路径。' : 'This browser still holds another account’s local data. Uploads to this account are paused; choose a recovery path first.')
    : conflict
      ? (zh ? `本机与${remoteLabel}出现分叉，自动同步已暂停。其他设备可能没有这里的最新修改；请先选择保留哪一份。` : `This device and the ${remoteLabel} diverged, so automatic sync is paused. Other devices may not have these latest changes; choose which copy to keep.`)
      : connectionError
        ? (zh ? '最近一次连接或同步失败。已保存在此浏览器的内容仍可查看，其他设备可能暂时没有最新修改；请检查连接后重试。' : 'The latest connection or sync failed. Saved content on this browser remains available; other devices may not have the latest changes. Check the connection and retry.')
        : !user
          ? (zh ? '当前内容只保存在此设备。登录并完成连接前，其他设备看不到这些修改。' : 'Current content is on this device only. Other devices cannot see these changes until you sign in and connect.')
          : audience && !audience.allowed
            ? (zh ? '此账号尚未获准使用跨设备工作区。本机资料仍可查看和编辑；其他设备不会收到这些修改。' : 'This account does not yet have cross-device workspace access. You can still view and edit local data; other devices will not receive these changes.')
          : transactional
            ? (zh ? '已连接账号工作区。此浏览器保留工作副本；若连接中断，请先核对保存结果，再依提示恢复。' : 'Your account workspace is connected. This browser keeps a working copy; if the connection drops, verify the save result before retrying.')
            : (zh ? '已登录；其他设备以最近一次成功同步的数据为准。' : 'Signed in. Other devices have data from the latest successful sync.')

  useEffect(() => {
    let active = true
    if (!user) {
      setAudience(undefined)
      return () => { active = false }
    }
    void fetchAudienceStatus()
      .then((value) => { if (active) setAudience(value) })
      .catch(() => { if (active) setAudience(undefined) })
    return () => { active = false }
  }, [user?.accountId])

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
    : cloud.outcome.kind === 'created' ? (zh ? `${remoteLabel}已准备好` : `${remoteLabel} is ready`)
      : cloud.outcome.kind === 'pushed' ? (zh ? `本地修改已同步到 ${remoteLabel}` : `Local changes synced to ${remoteLabel}`)
        : cloud.outcome.kind === 'local_pending' ? (zh ? '本机有未进入账号工作区的修改；同步检查已保留本机数据，未上传整份工作区' : 'Local changes have not reached the account workspace; sync preserved them without uploading the whole workspace')
        : cloud.outcome.kind === 'pulled' ? (zh ? `已从 ${remoteLabel} 拉取修改` : `Changes downloaded from ${remoteLabel}`)
          : cloud.outcome.kind === 'conflict' ? (zh ? '检测到同步冲突' : 'Sync conflict detected')
            : cloud.outcome.kind === 'account_mismatch' ? (zh ? 'TodayAction 账号与本地工作区不匹配' : 'TodayAction account does not match local workspace')
              : (zh ? '已同步' : 'Synced')

  return (
    <>
      <section className="cloud-settings-card">
        <div className="cloud-settings-heading">
          <div>
            <div className="eyebrow">ACCOUNT & CONNECTION</div>
            <h2>{zh ? '账号与跨设备数据' : 'Account & cross-device data'}</h2>
            <p>{transactional
              ? (zh
                  ? '账号工作区保存跨设备数据；此浏览器保留工作副本。Google Drive 可用于备份、导出和携带资料。'
                  : 'Your account workspace keeps cross-device data while this browser holds a working copy. Google Drive remains available for backup and export.')
              : (zh
                  ? '此浏览器可保存日常修改，Google Drive 保存同步副本。连接中断时，其他设备可能暂时看不到最新内容。'
                  : 'This browser saves daily changes and Google Drive holds the synced copy. Other devices may lag while the connection is unavailable.')}</p>
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

        <div className={`cloud-connection-impact ${mismatch || conflict || connectionError ? 'warning' : ''}`} role="status">
          <strong>{zh ? '当前数据可用性' : 'What is available now'}</strong>
          <span>{impact}</span>
        </div>

        {!user ? (
          <div className="cloud-auth-row">
            <div>
              <strong>{zh ? '使用 Google 登录 TodayAction' : 'Sign in to TodayAction with Google'}</strong>
              <p>{zh
                ? '首次登录会申请 openid/profile/email 与 drive.appdata，并建立可持续的 Drive 授权。之后刷新页面或重新打开浏览器，不应要求你再次登录。TodayAction 不能浏览普通 Google Drive 文件。'
                : 'The first sign-in requests openid/profile/email plus drive.appdata and creates durable Drive authorization. Refreshing or reopening the browser should not require another sign-in. TodayAction cannot browse normal Drive files.'}</p>
            </div>
            <button className="primary-button" disabled={cloud.loading || cloud.syncing} onClick={() => { void run(cloud.signIn) }}>
              {cloud.loading ? (zh ? '正在恢复…' : 'Restoring…') : (zh ? '使用 Google 登录' : 'Sign in with Google')}
            </button>
          </div>
        ) : (
          <>
            {audience ? (
              <div className={`cloud-audience-state ${audience.allowed ? 'allowed' : 'blocked'}`}>
                <div><strong>{audience.allowed ? (zh ? '跨设备功能可用' : 'Cross-device access available') : (zh ? '跨设备功能尚未开通' : 'Cross-device access unavailable')}</strong><span>{audience.allowed ? (zh ? '当前账号可使用跨设备资料。' : 'This account can use its cross-device workspace.') : (zh ? '当前账号仍可使用本机资料；跨设备资料暂不可用。' : 'Local data remains available, but this account cannot use cross-device data yet.')}</span></div>
              </div>
            ) : null}

            <div className="cloud-account-row">
              <div>
                <span>{zh ? 'TodayAction 账号' : 'TodayAction account'}</span>
                <strong>{user.user_metadata?.full_name || user.email || user.id}</strong>
                {user.email ? <small>{user.email}</small> : null}
              </div>
              <div>
                <span>{zh ? '最后同步' : 'Last sync'}</span>
                <strong>{formatTime(cloud.checkpoint.lastSyncedAt, zh)}</strong>
                <small>{cloud.checkpoint.lastSyncedVersion ? (zh ? '此账号已有可核对的保存版本' : 'A saved account version is available') : (zh ? '尚无已确认的同步版本' : 'No confirmed synced version yet')}</small>
              </div>
              <div>
                <span>{zh ? '此设备' : 'This device'}</span>
                <strong>{zh ? '本机资料可用' : 'Local data available'}</strong>
                <small>{transactional ? (zh ? '账号资料的本机工作副本' : 'Working copy of account data') : (zh ? '本机保存，按连接状态同步' : 'Saved locally and synced when connected')}</small>
              </div>
            </div>

            {mismatch ? (
              <div className="cloud-conflict-box">
                <strong>{zh ? '为避免跨账号上传，自动同步已暂停。' : 'Auto-sync is paused to prevent cross-account uploads.'}</strong>
                <p>{zh
                  ? '这个浏览器里的本地工作区已经绑定过另一个 Google 身份。TodayAction 不会自动把那份求职数据上传到当前账号。'
                  : 'The local workspace in this browser is already bound to another Google identity. TodayAction will not upload that job-search data into the current account automatically.'}</p>
                <div>
                  <button onClick={() => {
                    if (window.confirm(zh ? `确认把当前本地工作区重新绑定到这个 TodayAction 账号？如果该账号已有${remoteLabel}数据，系统会先进入冲突处理，不会直接覆盖。` : `Rebind the current local workspace to this TodayAction account? Existing ${remoteLabel} data will trigger conflict handling rather than being overwritten.`)) void run(cloud.rebindLocal)
                  }}>{zh ? '绑定当前本地工作区' : 'Bind current local workspace'}</button>
                  <button className="danger" onClick={() => {
                    if (window.confirm(zh ? `确认用当前账号的${remoteLabel}替换本机工作区？本机尚未同步的修改会丢失。` : `Replace this device workspace with the current account ${remoteLabel}? Unsynced local changes will be lost.`)) void run(cloud.useCloud)
                  }}>{zh ? `使用此账号的${remoteLabel}` : `Use this account’s ${remoteLabel}`}</button>
                </div>
              </div>
            ) : conflict ? (
              <div className="cloud-conflict-box">
                <strong>{zh ? `本机和${remoteLabel}在上次同步后都发生了修改。` : `Both this device and the ${remoteLabel} changed after the last sync.`}</strong>
                <p>{zh ? `远端版本 ${conflict.remoteVersion}，更新时间 ${formatTime(conflict.remoteUpdatedAt, zh)}。系统已停止自动同步，没有覆盖任何一方。` : `Remote version ${conflict.remoteVersion}, updated ${formatTime(conflict.remoteUpdatedAt, zh)}. Auto-sync stopped and neither side was overwritten.`}</p>
                <div>
                  <button onClick={() => {
                    if (window.confirm(zh ? `确认以本机数据为准覆盖${remoteLabel}？` : `Keep this device and overwrite the ${remoteLabel}?`)) void run(cloud.keepLocal)
                  }}>{zh ? '保留本机' : 'Keep this device'}</button>
                  <button className="danger" onClick={() => {
                    if (window.confirm(zh ? `确认以${remoteLabel}数据为准替换本机？本机未同步修改会丢失。` : `Use the ${remoteLabel} version and replace local data? Unsynced local changes will be lost.`)) void run(cloud.useCloud)
                  }}>{zh ? `使用${remoteLabel}` : `Use ${remoteLabel}`}</button>
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
                <button disabled={cloud.syncing || cloud.loading} onClick={() => { void run(cloud.signOut) }}>{zh ? '退出 TodayAction' : 'Sign out of TodayAction'}</button>
              </div>
            </div>
            {outcomeLabel ? <div className="cloud-result">{outcomeLabel}</div> : null}
          </>
        )}

        {(localError || cloud.error || cloud.checkpoint.lastError) ? <div className="cloud-error">{localError || cloud.error || cloud.checkpoint.lastError}</div> : null}
        <small className="cloud-security-note">{transactional
          ? (zh
              ? 'Google 长期授权凭据在服务端加密保存。退出账号会清除此设备上的账号缓存，避免下一个登录者看到前一个账号的资料；已同步的账号资料仍保留。TodayAction 只获得应用专用的 Google Drive 文件权限。'
              : 'Long-lived Google authorization is encrypted on the server. Signing out clears this device’s account cache so the next sign-in cannot see the previous account’s data; already synced account data remains stored. TodayAction only receives access to its app-specific Google Drive files.')
          : (zh
              ? 'Google 长期授权凭据在服务端加密保存。此设备仍会保留本机资料；在共享设备上使用后，请按需要清理浏览器资料。TodayAction 只获得应用专用的 Google Drive 文件权限。'
              : 'Long-lived Google authorization is encrypted on the server. Local data remains on this device; clear browser data after use on a shared device when needed. TodayAction only receives access to its app-specific Google Drive files.')}</small>
      </section>
      <AiAccessSettingsCard />
    </>
  )
}
