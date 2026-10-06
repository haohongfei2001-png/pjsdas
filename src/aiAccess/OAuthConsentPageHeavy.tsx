import { useEffect, useMemo, useState } from 'react'
import BrandMark from '../BrandMark.js'
import './oauthConsent.css'
import { brandDocumentTitle } from '../brand.js'
import type { User } from '@supabase/supabase-js'
import { pjsdasSupabase } from './supabaseClient.js'

function authIdFromLocation() {
  if (typeof window === 'undefined') return ''
  return new URL(window.location.href).searchParams.get('authorization_id')?.trim() ?? ''
}

function cleanConsentReturnUrl() {
  const url = new URL(window.location.href)
  url.searchParams.delete('code')
  url.searchParams.delete('sb_flow_id')
  url.hash = ''
  return url.toString()
}

function scopeLabel(scope: string) {
  if (scope === 'openid') return '确认你的 TodayAction 身份'
  if (scope === 'email') return '读取你的登录邮箱'
  if (scope === 'profile') return '读取基础账户资料'
  if (scope === 'offline_access') return '保持 ChatGPT 授权，无需每小时重新登录'
  return scope
}

type AuthorizationDetails = {
  authorization_id?: string
  redirect_url?: string
  redirect_uri?: string
  scope?: string
  client?: { name?: string }
}

export default function OAuthConsentPage() {
  const authorizationId = useMemo(authIdFromLocation, [])
  useEffect(() => { document.title = brandDocumentTitle('authorization', 'zh') }, [])
  const [user, setUser] = useState<User | null>(null)
  const [details, setDetails] = useState<AuthorizationDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    if (!authorizationId) {
      setError('缺少 authorization_id，无法继续授权。')
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')
    try {
      const { data: sessionData, error: sessionError } = await pjsdasSupabase.auth.getSession()
      if (sessionError) throw sessionError
      const currentUser = sessionData.session?.user ?? null
      setUser(currentUser)
      if (!currentUser) return

      const { data, error: detailsError } = await pjsdasSupabase.auth.oauth.getAuthorizationDetails(authorizationId)
      if (detailsError) throw detailsError
      const value = data as AuthorizationDetails
      if (!value.authorization_id && value.redirect_url) {
        window.location.assign(value.redirect_url)
        return
      }
      setDetails(value)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void load()
    const { data } = pjsdasSupabase.auth.onAuthStateChange(() => {
      window.setTimeout(() => {
        if (active) void load()
      }, 0)
    })
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [authorizationId])

  async function signIn() {
    setWorking(true)
    setError('')
    try {
      const { error: signInError } = await pjsdasSupabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: cleanConsentReturnUrl(),
          scopes: 'openid email profile',
        },
      })
      if (signInError) throw signInError
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setWorking(false)
    }
  }

  async function decide(decision: 'approve' | 'deny') {
    if (!authorizationId) return
    setWorking(true)
    setError('')
    try {
      const result = decision === 'approve'
        ? await pjsdasSupabase.auth.oauth.approveAuthorization(authorizationId)
        : await pjsdasSupabase.auth.oauth.denyAuthorization(authorizationId)
      if (result.error) throw result.error
      if (!result.data?.redirect_url) throw new Error('授权服务器没有返回回跳地址。')
      window.location.assign(result.data.redirect_url)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setWorking(false)
    }
  }

  const scopes = (details?.scope ?? '').split(/\s+/).filter(Boolean)

  return (
    <main className="ta-consent">
      <section className="ta-consent-panel">
        <div className="ta-consent-brand"><BrandMark size={30} /> TodayAction · CHATGPT ACCESS</div>
        <h1>授权 ChatGPT 访问 TodayAction</h1>
        <p>
          本页确认当前账号的身份连接和下方列出的登录权限。可用工具取决于这个账号已开放的功能和你另行确认的数据授权；连接成功不代表所有功能已经开放。
        </p>
        <p>
          消费级业务管理需要连接后另行明确授权，仅包括独立准备任务、独立手动行动和投递组的查看、修改及支持恢复的撤销。本页不会授予这项权限，也不会自动开放机会资料、时间偏好、职位发现偏好或私人提醒。未授权或撤权后，客户端不能通过旧版基础工具继续访问消费级业务数据。
        </p>
        <p>
          仅对已开放旧版基础工具的既有账号：此 MCP 客户端可以读取你当前账号的 Today、岗位、招聘流程、准备任务、时间偏好与历史。它也可以按你在对话中明确给出的指令，新增岗位、记录投递与招聘进展、调整明确目标的截止时间和行动状态、修正有依据的事实，并撤销支持恢复的操作。每次写入都受身份校验、幂等、审计记账与工作区版本冲突保护。
        </p>
        <p>
          目标不明确时需要先澄清；受治理的重大修改仍需审阅。受信任的 Monitor / Gmail 摄入另外需要来源级授权；这类自动摄入不能静默修改持久偏好、拒绝决定，也不能删除数据。本次授权不包含扩展 workspace.manage 权限，不允许永久删除数据、修改账号安全设置，或向外部投递、发送消息、接受 Offer。
        </p>

        {loading ? <p>正在检查授权状态…</p> : null}

        {!loading && !user ? (
          <div style={{ marginTop: 24 }}>
            <p style={{ lineHeight: 1.65 }}>先使用你绑定 TodayAction 的 Google 账号登录。这里不会再次申请 Google Drive 权限。</p>
            <button disabled={working} onClick={() => { void signIn() }} className="ta-consent-primary">
              {working ? '正在前往 Google…' : '使用 Google 登录 TodayAction'}
            </button>
          </div>
        ) : null}

        {!loading && user && details ? (
          <div style={{ marginTop: 24 }}>
            <div className="ta-consent-details">
              <div><strong>请求方：</strong>{details.client?.name || 'ChatGPT / MCP client'}</div>
              <div><strong>当前账号：</strong>{user.email || user.id}</div>
              {details.redirect_uri ? <div style={{ wordBreak: 'break-all' }}><strong>回跳地址：</strong>{details.redirect_uri}</div> : null}
            </div>
            <h2 style={{ fontSize: 17, marginTop: 22 }}>请求权限</h2>
            <ul style={{ lineHeight: 1.8, paddingLeft: 22 }}>
              {(scopes.length ? scopes : ['email']).map((scope) => <li key={scope}>{scopeLabel(scope)}</li>)}
            </ul>
            <p className="ta-consent-note">
              从空工作区开始不需要连接 Gmail 或 Google Drive。如果你另行选择连接 Drive，其 appDataFolder 授权由 TodayAction 网站单独建立并加密保存；本页不会把 Google refresh token 交给 ChatGPT。TodayAction 自己执行并约束所有持久化写入。
            </p>
            <div className="ta-consent-actions">
              <button disabled={working} onClick={() => { void decide('approve') }} className="ta-consent-primary">
                {working ? '处理中…' : '允许此访问'}
              </button>
              <button disabled={working} onClick={() => { void decide('deny') }} className="ta-consent-secondary">
                拒绝
              </button>
            </div>
          </div>
        ) : null}

        {error ? <div className="ta-consent-error" role="alert">{error}</div> : null}
      </section>
    </main>
  )
}
