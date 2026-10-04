import { useEffect, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import BrandMark from '../BrandMark.js'
import { pjsdasSupabase } from './supabaseClient.js'
import './oauthConsent.css'

// This filter prevents accidental use of real identities on the demonstration
// surface. It is not an authorization boundary: the server still checks audience,
// exact account/client, current domain consent and workspace ownership every time.
const demoEmail = /^ta-consumer-review-[ab]-[0-9a-f-]{36}@example\.invalid$/

export default function ReviewerSignInPageHeavy() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const busy = useRef(false)
  const generation = useRef(0)

  useEffect(() => {
    document.title = 'TodayAction · 演示账号登录'
    let active = true
    let revision = 0
    const { data } = pjsdasSupabase.auth.onAuthStateChange((_event, session) => {
      revision += 1
      if (!active) return
      generation.current += 1
      setUser(session?.user ?? null)
      setEmail(''); setPassword(''); setError(''); setLoading(false)
    })
    const start = revision
    void pjsdasSupabase.auth.getSession().then(({ data: current, error: failure }) => {
      if (!active || revision !== start) return
      setUser(current.session?.user ?? null)
      if (failure) setError('无法确认登录状态，请重新打开此页。')
      setLoading(false)
    }).catch(() => { if (active && revision === start) { setError('无法确认登录状态，请重新打开此页。'); setLoading(false) } })
    return () => { active = false; generation.current += 1; data.subscription.unsubscribe() }
  }, [])

  async function signIn() {
    if (busy.current || loading || user) return
    const address = email.trim().toLowerCase()
    if (!demoEmail.test(address)) { setError('请使用为审核准备的专用演示账号；不要输入个人账号。'); return }
    busy.current = true; setWorking(true); setError('')
    const attempt = generation.current
    const submittedPassword = password
    setPassword('')
    try {
      // Use the existing provider; no signup, password reset, session injection,
      // OAuth approval, business grant or workspace mutation is performed here.
      const result = await pjsdasSupabase.auth.signInWithPassword({ email: address, password: submittedPassword })
      if (generation.current === attempt && result.error) setError('登录未完成。请检查演示账号信息或联系审核支持。')
    } catch {
      if (generation.current === attempt) setError('登录未完成。请检查网络后重试。')
    } finally {
      busy.current = false; setWorking(false)
    }
  }

  return <main className="ta-consent"><section className="ta-consent-panel">
    <div className="ta-consent-brand"><BrandMark size={30} /> TodayAction</div>
    <h1>演示账号登录</h1>
    <p>使用审核资料中提供的专用账号。登录只确认身份；连接插件和数据权限需要另行明确确认。</p>
    {loading ? <p role="status">正在确认登录状态…</p> : user ? <>
      <p role="status">{demoEmail.test(user.email ?? '') ? '演示账号已登录。' : '当前浏览器已有其他账号登录。请保留此账号，在独立测试浏览器中使用演示账号。'}</p>
      {demoEmail.test(user.email ?? '') ? <>
        <p>返回原 TodayAction 插件继续连接，再选择业务权限。重复登录不会创建工作区或自动授权。</p>
        <a href="?connect=1">查看工作区与授权</a>
      </> : null}
    </> : <form className="ta-reviewer-signin" onSubmit={event => { event.preventDefault(); void signIn() }}>
      <label htmlFor="reviewer-email">演示账号</label>
      <input id="reviewer-email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} value={email} onChange={event => setEmail(event.target.value)} disabled={working} required />
      <label htmlFor="reviewer-password">密码</label>
      <input id="reviewer-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={working} required />
      <button className="ta-consent-primary" disabled={working}>{working ? '正在登录…' : '登录演示账号'}</button>
    </form>}
    {error ? <p className="ta-consent-error" role="alert">{error}</p> : null}
    <p className="ta-consent-note">这里不注册账号、不重置密码，也不读取或修改工作区。</p>
  </section></main>
}
