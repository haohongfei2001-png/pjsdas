import { connectedWorkspaceAuthorityEnabled } from './cloud/connectedWorkspaceRepository.js'
import { originTransitionState } from './productionTopology.js'
import { useUiLanguage } from './uiLanguage.js'
import './originTransition.css'

export default function OriginTransitionNotice({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const state = originTransitionState()
  if (!state.transitionRequired) return null
  const transactional = connectedWorkspaceAuthorityEnabled()

  return (
    <div className={`origin-transition-notice ${transactional ? 'ready' : 'warning'}`}>
      <div>
        <strong>{transactional
          ? (zh ? '当前是旧域名，connected authority 已启用' : 'Legacy origin detected; connected authority is active')
          : (zh ? '当前是旧域名：不要先清浏览器数据' : 'Legacy origin detected: do not clear browser data yet')}</strong>
        <span>{transactional
          ? (zh ? '新域名登录后可从 transactional workspace 恢复，不需要跨 origin 读取 IndexedDB。' : 'The new origin can recover from the transactional workspace after sign-in; cross-origin IndexedDB access is unnecessary.')
          : (zh ? '先在 Settings → 数据与恢复完成 connected migration，再切换到正式域名。' : 'Complete connected migration under Settings → Data & recovery before moving to the canonical domain.')}</span>
      </div>
      <button type="button" onClick={onOpenSettings}>{zh ? '打开迁移设置' : 'Open migration settings'}</button>
    </div>
  )
}
