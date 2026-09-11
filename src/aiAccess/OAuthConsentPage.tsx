import { useEffect, useMemo, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { pjsdasSupabase } from './supabaseClient'

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
  if (scope === 'openid') return '确认你的 PJSDAS 身份'
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
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f2ead7', color: '#292720' }}>
      <section style={{ width: 'min(620px, 100%)', background: '#fffaf0', border: '1px solid rgba(41,39,32,.16)', borderRadius: 24, padding: 32, boxShadow: '0 20px 60px rgba(41,39,32,.08)' }}>
        <div style={{ fontSize: 12, letterSpacing: '.12em', fontWeight: 700, opacity: .58 }}>PJSDAS · CHATGPT ACCESS</div>
        <h1 style={{ margin: '10px 0 8px', fontSize: 30 }}>授权 ChatGPT 读取 PJSDAS</h1>
        <p style={{ lineHeight: 1.7, opacity: .78 }}>
          此授权仅用于 v1.1 的只读工具。ChatGPT 可以读取你的 Today、岗位、Pipeline、Decision Rules 与 Timeline；不能修改、删除或提交任何 PJSDAS 数据。
        </p>

        {loading ? <p>正在检查授权状态…</p> : null}

        {!loading && !user ? (
          <div style={{ marginTop: 24 }}>
            <p style={{ lineHeight: 1.65 }}>先使用你绑定 PJSDAS 的 Google 账号登录。这里不会再次申请 Google Drive 权限。</p>
            <button disabled={working} onClick={() => { void signIn() }} style={{ padding: '12px 18px', border: 0, borderRadius: 12, background: '#292720', color: '#fff', cursor: 'pointer' }}>
              {working ? '正在前往 Google…' : '使用 Google 登录 PJSDAS'}
            </button>
          </div>
        ) : null}

        {!loading && user && details ? (
          <div style={{ marginTop: 24 }}>
            <div style={{ padding: 16, borderRadius: 14, background: 'rgba(41,39,32,.05)', lineHeight: 1.65 }}>
              <div><strong>请求方：</strong>{details.client?.name || 'ChatGPT / MCP client'}</div>
              <div><strong>当前账号：</strong>{user.email || user.id}</div>
              {details.redirect_uri ? <div style={{ wordBreak: 'break-all' }}><strong>回跳地址：</strong>{details.redirect_uri}</div> : null}
            </div>
            <h2 style={{ fontSize: 17, marginTop: 22 }}>请求权限</h2>
            <ul style={{ lineHeight: 1.8, paddingLeft: 22 }}>
              {(scopes.length ? scopes : ['email']).map((scope) => <li key={scope}>{scopeLabel(scope)}</li>)}
            </ul>
            <p style={{ fontSize: 13, opacity: .68, lineHeight: 1.6 }}>
              Google Drive 的 appDataFolder 授权由 PJSDAS 网站单独建立并加密保存；本页不会把 Google refresh token 交给 ChatGPT。
            </p>
            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button disabled={working} onClick={() => { void decide('approve') }} style={{ padding: '12px 18px', border: 0, borderRadius: 12, background: '#292720', color: '#fff', cursor: 'pointer' }}>
                {working ? '处理中…' : '允许只读访问'}
              </button>
              <button disabled={working} onClick={() => { void decide('deny') }} style={{ padding: '12px 18px', border: '1px solid rgba(41,39,32,.22)', borderRadius: 12, background: 'transparent', color: '#292720', cursor: 'pointer' }}>
                拒绝
              </button>
            </div>
          </div>
        ) : null}

        {error ? <div style={{ marginTop: 22, padding: 14, borderRadius: 12, background: '#fff0ed', color: '#8b2e25' }}>{error}</div> : null}
      </section>
    </main>
  )
}
