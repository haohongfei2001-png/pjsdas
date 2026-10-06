import { useEffect, useRef, useState } from 'react'
import { useUiLanguage } from '../uiLanguage.js'
import { useCloud } from './CloudContext.js'
import { connectedWorkspaceAuthorityEnabled } from './connectedWorkspaceRepository.js'
import { hasUnsyncedLocalWorkspace, inspectConnectedDivergence } from './cloudSync.js'
import { useAiAccess } from '../aiAccess/AiAccessContext.js'
import { accountGoogleConnection, accountGoogleConnectionLabel } from './accountGoogleConnection.js'
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
  const ai = useAiAccess()
  const automation = ai.gmailAutomation
  const googleConnection = accountGoogleConnection({ verified: ai.statusVerified && Boolean(automation), ...automation })
  const googleNeedsRepair = googleConnection === 'not_connected' || googleConnection === 'reconnect_required'
  const googleNeedsAttention = googleNeedsRepair || googleConnection === 'configuration_error'
  const [checkingGoogle, setCheckingGoogle] = useState(false)
  const [localError, setLocalError] = useState('')
  const [audience, setAudience] = useState<AudienceStatus>()
  const [diagnostic, setDiagnostic] = useState<Awaited<ReturnType<typeof inspectConnectedDivergence>>>()
  const [localDirty, setLocalDirty] = useState<boolean | undefined>()
  const advancedRef = useRef<HTMLDetailsElement>(null)
  const user = cloud.session?.user
  const mismatch = Boolean(user && cloud.device.workspaceOwnerUserId && cloud.device.workspaceOwnerUserId !== user.id)
  const conflict = cloud.checkpoint.conflict
  const transactional = connectedWorkspaceAuthorityEnabled()
  const remoteLabel = transactional ? (zh ? '账号工作区' : 'account workspace') : 'Google Drive'
  const connectionError = localError || cloud.error || cloud.checkpoint.lastError
  const codedLocalError = /^[A-Z][A-Z0-9_]+:/.test(localError)
  const pendingLocal = cloud.outcome?.kind === 'local_pending'
  const currentLocal = !transactional || localDirty === false
  const quietConnected = Boolean(user && !mismatch && !conflict && !connectionError && !pendingLocal && currentLocal && googleConnection === 'connected' && (!audience || audience.allowed))
  useEffect(() => {
    if (!user || !transactional) {
      setLocalDirty(undefined)
      return
    }
    let active = true
    let sequence = 0
    setLocalDirty(undefined)
    const check = () => {
      const current = ++sequence
      void hasUnsyncedLocalWorkspace(user.id)
        .then(value => { if (active && current === sequence) setLocalDirty(value) })
        .catch(() => { if (active && current === sequence) setLocalDirty(undefined) })
    }
    check()
    window.addEventListener('focus', check)
    window.addEventListener('pjsdas:workspace-replaced', check)
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') check() }, 15_000)
    return () => {
      active = false
      window.removeEventListener('focus', check)
      window.removeEventListener('pjsdas:workspace-replaced', check)
      window.clearInterval(interval)
    }
  }, [user?.id, transactional, cloud.checkpoint.lastSyncedFingerprint, cloud.checkpoint.lastReadProjectionFingerprint, cloud.syncing])
  const impact = mismatch
    ? (zh ? '此设备保存着另一个账号的资料。请先切回原账号；双方资料均已保留。' : 'This device holds another account’s data. Return to that account; both copies are preserved.')
    : conflict
      ? (zh ? '此设备有尚未核对的修改。自动检查会继续；双方资料均已保留。' : 'This device has changes that still need review. Automatic checks continue and both copies are preserved.')
      : connectionError
        ? (zh ? '连接暂时中断。已保存的内容仍可查看，其他设备可能尚未收到最新修改。' : 'The connection is interrupted. Saved content remains available; other devices may not have the latest changes.')
      : !user
          ? (zh ? '当前内容只保存在此设备。登录并完成连接前，其他设备看不到这些修改。' : 'Current content is on this device only. Other devices cannot see these changes until you sign in and connect.')
          : audience && !audience.allowed
            ? (zh ? '此账号尚未开通跨设备使用；此设备上的资料仍可查看。' : 'Cross-device access is unavailable for this account; data on this device remains available.')
            : pendingLocal
              ? (zh ? '部分修改仍在此设备，系统会继续核对保存结果。' : 'Some changes remain on this device while their save result is checked.')
              : transactional && localDirty
                ? (zh ? '此设备有尚未同步的修改。' : 'This device has changes that have not synced yet.')
                : transactional && localDirty === undefined
                  ? (zh ? '正在核对此设备的最新修改。' : 'Checking this device for recent changes.')
                : googleConnection === 'unverified'
                  ? (zh ? '账号已登录，Google 连接状态暂时无法核对。' : 'You are signed in; the Google connection has not been verified yet.')
                  : googleConnection === 'configuration_error'
                    ? (zh ? 'Google 连接需要维护。已保存的资料仍保留，请查看错误详情。' : 'The Google connection needs attention. Saved data is preserved; see the error details.')
                    : googleNeedsRepair
                      ? (zh ? '请完成 Google 连接，让已授权的来源继续更新。邮件跟踪和岗位发现仍需分别启用。' : 'Complete the Google connection so authorized sources can keep updating. Email tracking and job discovery still need to be enabled separately.')
              : (zh ? '你的资料已连接此账号，并在设备间保持更新。' : 'Your data is connected to this account and stays up to date across devices.')

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
      <section className="cloud-settings-card settings-account" aria-label={zh ? '账号与跨设备数据' : 'Account & cross-device data'}>
        <div className="cloud-settings-heading">
          <div>
            <h2>{zh ? '账号' : 'Account'}</h2>
            <p>{user ? `${user.user_metadata?.full_name || user.email || user.id}` : cloud.loading ? (zh ? '正在恢复登录…' : 'Restoring session…') : (zh ? '内容仅保存在此设备' : 'Data is saved on this device only')}</p>
          </div>
          {user ? <span className={`cloud-state ${conflict || mismatch || connectionError || pendingLocal || (transactional && localDirty) || (audience && !audience.allowed) || (user && googleNeedsAttention) ? 'warning' : user && currentLocal && googleConnection === 'connected' ? 'online' : ''}`}>
            {mismatch
              ? (zh ? '账号不匹配' : 'Account mismatch')
              : conflict
                ? (zh ? '需要核对' : 'Needs review')
                : connectionError
                  ? (zh ? '连接中断' : 'Connection interrupted')
                : pendingLocal
                  ? (zh ? '等待核对' : 'Checking changes')
                : transactional && localDirty
                  ? (zh ? '待同步修改' : 'Unsynced changes')
                : audience && !audience.allowed
                  ? (zh ? '跨设备不可用' : 'Cross-device unavailable')
                : user && googleConnection !== 'connected'
                  ? accountGoogleConnectionLabel(googleConnection, zh)
                : user
                  ? cloud.checkpoint.lastSyncedVersion && currentLocal
                    ? (zh ? '同步正常' : 'Sync is up to date')
                    : (zh ? '正在核对' : 'Checking')
                  : cloud.loading
                    ? (zh ? '正在恢复登录…' : 'Restoring session…')
                    : (zh ? '仅本机' : 'Local only')}
          </span> : null}
        </div>

        {user && !quietConnected ? <div className={`cloud-connection-impact ${mismatch || conflict || connectionError || (audience && !audience.allowed) || (user && googleNeedsAttention) ? 'warning' : 'settings-account-status'}`}>
          <strong>{user ? (zh ? `最后更新：${formatTime(cloud.checkpoint.lastSyncedAt, zh)}` : `Last updated: ${formatTime(cloud.checkpoint.lastSyncedAt, zh)}`) : (zh ? '仅保存在此设备' : 'Saved on this device only')}</strong>
          {!user || mismatch || conflict || connectionError || pendingLocal || localDirty || (audience && !audience.allowed) || (user && googleConnection !== 'connected') ? <span role="status">{impact}</span> : null}
          {user && googleConnection === 'unverified' ? <button type="button" disabled={ai.busy || checkingGoogle} onClick={() => {
            setCheckingGoogle(true)
            void ai.refreshGmailAutomationStatus().finally(() => setCheckingGoogle(false))
          }}>{checkingGoogle ? (zh ? '正在核对…' : 'Checking…') : (zh ? '重新核对连接' : 'Check connection again')}</button> : null}
          {user && googleNeedsRepair && !mismatch && !conflict ? <button type="button" onClick={() => {
            if (advancedRef.current) advancedRef.current.open = true
            advancedRef.current?.querySelector('summary')?.focus()
          }}>{zh ? '查看连接修复' : 'Review connection repair'}</button> : null}
          {mismatch || conflict ? <button type="button" onClick={() => {
            if (advancedRef.current) advancedRef.current.open = true
            advancedRef.current?.querySelector('summary')?.focus()
          }}>{zh ? '查看安全恢复方式' : 'View safe recovery options'}</button> : null}
        </div> : null}

        {!user ? (
          <div className="cloud-auth-row settings-signin">
            <button className="primary-button" disabled={cloud.loading || cloud.syncing} onClick={() => { void run(cloud.signIn) }}>
              {cloud.loading ? (zh ? '正在恢复…' : 'Restoring…') : (zh ? '使用 Google 登录' : 'Sign in with Google')}
            </button>
            <details className="settings-scope-details settings-signin-permission">
              <summary>{zh ? '授权说明' : 'Permissions'}</summary>
              <p className="settings-permission">{zh
                ? '首次登录申请基本身份信息和应用专用的 Google Drive 文件权限；TodayAction 不能浏览普通 Drive 文件。'
                : 'The first sign-in requests basic identity and app-specific Google Drive file access. TodayAction cannot browse ordinary Drive files.'}</p>
            </details>
          </div>
        ) : (
          <>
            <details ref={advancedRef} className="cloud-advanced">
              <summary aria-label={zh ? '管理账号与同步' : 'Manage account and sync'}>{zh ? '管理' : 'Manage'}</summary>
              <div className="cloud-advanced-content">
                <p>{zh ? `最后更新：${formatTime(cloud.checkpoint.lastSyncedAt, zh)}` : `Last updated: ${formatTime(cloud.checkpoint.lastSyncedAt, zh)}`}</p>
                <div className="cloud-account-identity">
                  <span>{zh ? 'TodayAction 账号' : 'TodayAction account'}</span>
                  <strong>{user.user_metadata?.full_name || user.email || user.id}</strong>
                  <button disabled={cloud.syncing || cloud.loading} onClick={() => { void run(cloud.signOut) }}>{zh ? '退出 TodayAction' : 'Sign out of TodayAction'}</button>
                </div>
                <div className="settings-google-connection">
                  <p>{automation?.googleEmail ? `${zh ? '已关联 Google：' : 'Linked Google: '}${automation.googleEmail}` : accountGoogleConnectionLabel(googleConnection, zh)}</p>
                  <p className="settings-permission">{zh ? 'Google 连接使用基本身份信息和应用专用的 Drive 文件权限，不会浏览普通 Drive 文件。长期授权信息会加密保存；重新连接会打开 Google 授权页面。邮件跟踪和岗位发现仍需在下方分别启用。' : 'The Google connection uses basic identity and app-specific Drive file access, not ordinary Drive files. Long-lived authorization is encrypted; reconnecting opens the Google consent page. Enable email tracking and job discovery separately below.'}</p>
                  <button type="button" className="settings-quiet-button" disabled={ai.busy || cloud.loading || cloud.syncing} onClick={() => { void ai.beginGoogleDriveLink() }}>{ai.busy ? (zh ? '处理中…' : 'Working…') : googleConnection === 'not_connected' ? (zh ? '连接 Google' : 'Connect Google') : (zh ? '重新连接 Google' : 'Reconnect Google')}</button>
                  <details className="settings-scope-details"><summary>{zh ? '后台更新与授权范围' : 'Background updates and permissions'}</summary><p>{zh ? '网页关闭后，已授权的来源仍可带来新的岗位和招聘进展。AI 读取与受信任的岗位发现、招聘邮件摄入只能加入有来源依据的有限事实；修改长期偏好、拒绝决定或删除资料仍需你审阅确认。每项来源都能单独关闭。新进展须经过来源、身份、重复项和冲突检查，才会写入账号资料。' : 'Authorized sources can bring in new opportunities and recruiting progress while this page is closed. AI reading and trusted discovery or recruiting-email intake may add only bounded, source-backed facts; changes to durable preferences, rejection decisions, or deletions still require your review. Each source can be turned off. New progress is checked for source, identity, duplicates, and conflicts before it enters your account data.'}</p></details>
                </div>
                <p>{zh ? '管理此设备的登录与同步。下面的差异核对不会修改账号资料。' : 'Manage sign-in and sync on this device. Difference inspection does not change account data.'}</p>
                {audience ? <p>{audience.allowed
                  ? (zh ? '跨设备功能可用。' : 'Cross-device access is available.')
                  : (zh ? '此账号尚未开通跨设备功能。' : 'Cross-device access is unavailable for this account.')}</p> : null}
                <div className="cloud-controls">
                  <label>
                    <input type="checkbox" checked={cloud.device.autoSync} onChange={(event) => cloud.setAutoSync(event.target.checked)} />
                    <span>{zh ? '自动同步' : 'Automatic sync'}</span>
                  </label>
                  <button disabled={cloud.syncing || mismatch || Boolean(conflict)} onClick={() => { void run(async () => cloud.syncNow()) }}>{cloud.syncing ? (zh ? '同步中…' : 'Syncing…') : (zh ? '立即同步' : 'Sync now')}</button>
                </div>
                {transactional && conflict ? <div className="cloud-diagnostic">
                  <button type="button" onClick={() => { void run(async () => {
                    const result = await inspectConnectedDivergence(user.id)
                    setDiagnostic(result)
                    if (['equal', 'order_only', 'cache_metadata', 'historical_read_only_evidence'].includes(result.classification)
                      && result.pendingOperations.count === 0) await cloud.reconcileEquivalent()
                  }) }}>{zh ? '只读核对差异' : 'Inspect difference without writing'}</button>
                  {diagnostic ? <div role="status">
                    <p>{['equal', 'order_only', 'cache_metadata', 'historical_read_only_evidence'].includes(diagnostic.classification)
                      ? (zh ? '差异只是缓存或记录顺序，系统可安全更新此设备。' : 'Only cache or ordering differs; this device can be updated safely.')
                      : diagnostic.classification === 'pending_operations'
                        ? (zh ? '仍有操作等待服务器确认；请等待自动核对回执。' : 'Some operations are awaiting server confirmation.')
                        : (zh ? '差异仍需人工核对。双方资料已保留，请先备份再考虑灾难恢复。' : 'The difference still needs review. Both copies are preserved; back up before disaster recovery.')}</p>
                    <small>{`local ${diagnostic.localFingerprint.slice(0, 12)} · projection ${diagnostic.localProjectionFingerprint?.slice(0, 12) ?? 'unavailable'} · authoritative ${diagnostic.authoritativeFingerprint?.slice(0, 12) ?? 'unavailable'} · checkpoint ${diagnostic.checkpointVersion ?? 'none'} · journal ${diagnostic.recordedProjection ? 'recorded' : 'unverified'} · pending ${diagnostic.pendingOperations.count}`}</small>
                  </div> : null}
                </div> : null}
                {conflict ? <p>{zh ? `最近核对的远端版本 ${conflict.remoteVersion}，更新时间 ${formatTime(conflict.remoteUpdatedAt, zh)}。` : `Last checked remote version ${conflict.remoteVersion}, updated ${formatTime(conflict.remoteUpdatedAt, zh)}.`}</p> : null}
                {mismatch || conflict ? <details className="cloud-disaster-recovery">
                  <summary>{zh ? '灾难恢复选项' : 'Disaster recovery options'}</summary>
                  <p>{zh ? '只有在自动恢复和人工核对均无法完成、且已单独备份双方资料时使用。选择一方可能使另一方独有的求职事实与历史记录丢失。' : 'Use only after automatic recovery and review fail, and after backing up both copies. Choosing one side can lose unique job-search facts and history from the other.'}</p>
                  <div>
                    {mismatch ? <button onClick={() => {
                      if (window.confirm(zh ? `这会把此设备的求职资料绑定到当前账号。若账号已有独立资料，将进入冲突核对。确认已备份双方资料？` : 'This binds this device’s job-search data to the current account. Existing separate account data will require conflict review. Have you backed up both copies?')) void run(cloud.rebindLocal)
                    }}>{zh ? '绑定当前本地工作区' : 'Bind this device workspace'}</button> : null}
                    {conflict ? <button onClick={() => {
                      if (window.confirm(zh ? `灾难恢复：用此设备的全部资料覆盖${remoteLabel}。账号中独有的求职事实和历史记录可能丢失。确认已备份双方资料？` : `Disaster recovery: overwrite all ${remoteLabel} data with this device. Unique account facts and history may be lost. Have you backed up both copies?`)) void run(cloud.keepLocal)
                    }}>{zh ? '保留本机' : 'Keep this device'}</button> : null}
                    <button className="danger" onClick={() => {
                      if (window.confirm(zh ? `灾难恢复：用${remoteLabel}替换此设备的全部资料。此设备未同步的求职事实和历史记录可能丢失。确认已备份双方资料？` : `Disaster recovery: replace all data on this device with ${remoteLabel}. Unsynced facts and history may be lost. Have you backed up both copies?`)) void run(cloud.useCloud)
                    }}>{zh ? `使用${remoteLabel}` : `Use ${remoteLabel}`}</button>
                  </div>
                </details> : null}
                {outcomeLabel ? <div className="cloud-result">{outcomeLabel}</div> : null}
                {codedLocalError ? <div className="cloud-error">{localError}</div> : null}
                {!localError && (cloud.error || cloud.checkpoint.lastError)
                  ? <div className="cloud-error">{cloud.error || cloud.checkpoint.lastError}</div> : null}
                <small className="cloud-security-note">{transactional
                  ? (zh
                      ? '退出账号会清除此设备上的账号缓存，避免下一个登录者看到前一个账号的资料；已同步的账号资料仍保留。Google 长期授权凭据在服务端加密保存，Drive 权限仅限应用专用文件。'
                      : 'Signing out clears this device’s account cache so the next sign-in cannot see the previous account’s data; already synced account data remains stored. Long-lived Google authorization is encrypted on the server, with Drive access limited to app-specific files.')
                  : (zh
                      ? 'Google 长期授权凭据在服务端加密保存。此设备仍会保留本机资料；在共享设备上使用后，请按需要清理浏览器资料。TodayAction 只获得应用专用的 Google Drive 文件权限。'
                      : 'Long-lived Google authorization is encrypted on the server. Local data remains on this device; clear browser data after use on a shared device when needed. TodayAction only receives access to its app-specific Google Drive files.')}</small>
              </div>
            </details>
          </>
        )}

        {ai.message ? <div className="cloud-result" role="status">{ai.message}</div> : null}
        {(ai.errorSource === 'status' || ai.errorSource === 'workspace') && ai.error ? <div className="cloud-error" role="alert"><strong>{ai.errorSource === 'status' ? (zh ? 'Google 连接状态暂时无法核对' : 'The Google connection status is unavailable') : (zh ? 'Google 连接未完成' : 'The Google connection could not be completed')}</strong><details><summary>{zh ? '错误详情' : 'Error details'}</summary><p>{ai.error}</p></details></div> : null}
        {localError ? <div className="cloud-error">{codedLocalError
          ? user
            ? (zh ? '操作暂时无法完成。请展开管理账号与同步查看详情。' : 'The action could not be completed. Expand Manage account and sync for details.')
            : (zh ? '登录暂时无法完成。' : 'Sign-in could not be completed.')
          : localError}
          {codedLocalError && !user ? <details><summary>{zh ? '查看错误详情' : 'View error details'}</summary><p>{localError}</p></details> : null}
        </div> : null}
        {!user && !localError && (cloud.error || cloud.checkpoint.lastError)
          ? <div className="cloud-error"><details>
            <summary>{zh ? '查看连接问题详情' : 'View connection error details'}</summary>
            <p>{cloud.error || cloud.checkpoint.lastError}</p>
          </details></div> : null}
      </section>
      <AiAccessSettingsCard />
    </>
  )
}
