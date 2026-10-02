import {
  readPendingOwnerConsent,
  savePendingOwnerConsent,
  clearPendingOwnerConsent,
} from './ownerConsentPending.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import BrandMark from '../BrandMark.js'
import { pjsdasSupabase } from './supabaseClient.js'
import {
  buildOwnerConsentDecision,
  createOwnerConsentClient,
  OwnerConsentError,
  type OwnerConsentDecision,
  type OwnerConsentView,
} from './ownerManagementConsentClient.js'
import './oauthConsent.css'
export default function OwnerManagementConsentPageHeavy() {
  const [view, setView] = useState<OwnerConsentView | null>(null)
  const [selected, setSelected] = useState(''),
    [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [needsLogin, setNeedsLogin] = useState(false)
  const [pending, setPending] = useState<OwnerConsentDecision | null>(null),
    [readAfterUnknown, setReadAfterUnknown] = useState(false)
  const epoch = useRef(0),
    flight = useRef(false),
    mounted = useRef(true),
    closing = useRef(false),
    accountShown = useRef<string | undefined>(undefined)
  const pendingByAccount = useRef(
    new Map<string, OwnerConsentDecision | null>(),
  )
  const client = useMemo(
    () =>
      createOwnerConsentClient({
        getSession: async () => {
          const { data, error } = await pjsdasSupabase.auth.getSession()
          if (error) throw error
          const s = data.session
          return s
            ? { accountId: s.user.id, accessToken: s.access_token }
            : null
        },
      }),
    [],
  )
  async function load(preserveMessage = false) {
    if (flight.current || closing.current) return
    const generation = ++epoch.current
    setBusy(true)
    if (!preserveMessage) setError('')
    setConfirmed(false)
    try {
      const next = await client.read()
      if (!mounted.current || generation !== epoch.current) return
      const sameAccount = accountShown.current === next.account.id
      accountShown.current = next.account.id
      const unresolved =
        readPendingOwnerConsent(next.account.id) ??
        pendingByAccount.current.get(next.account.id) ??
        null
      pendingByAccount.current.set(next.account.id, unresolved)
      setView(next)
      setNeedsLogin(false)
      setSelected(
        (current) =>
          unresolved?.clientId ??
          (sameAccount && next.clients.some((c) => c.id === current)
            ? current
            : ''),
      )
      setPending(unresolved)
      setReadAfterUnknown(Boolean(unresolved))
      setNotice((current) =>
        current.startsWith('这次决定已记录')
          ? '这次决定已记录；下方展示重新读取的当前授权状态。'
          : current,
      )
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return
      setView(null)
      setPending(null)
      setError(caught instanceof Error ? caught.message : '无法读取授权状态。')
      setNeedsLogin(
        caught instanceof OwnerConsentError &&
          caught.code === 'SIGN_IN_REQUIRED',
      )
    } finally {
      if (mounted.current && generation === epoch.current) setBusy(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    document.title = 'TodayAction · 扩展管理授权'
    void load()
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted || closing.current) {
        closing.current = false
        epoch.current++
        pendingByAccount.current.clear()
        setView(null)
        setSelected('')
        setConfirmed(false)
        setReadAfterUnknown(false)
        void load()
      }
    }
    window.addEventListener('pageshow', onPageShow)
    const { data } = pjsdasSupabase.auth.onAuthStateChange((event) => {
      if (!mounted.current) return
      if (event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') return
      epoch.current++
      accountShown.current = undefined
      setView(null)
      setSelected('')
      setConfirmed(false)
      setPending(null)
      setReadAfterUnknown(false)
      setNotice('账号状态已变化，请重新读取。')
      setBusy(flight.current)
      window.setTimeout(() => {
        if (mounted.current && !flight.current) void load()
      }, 0)
    })
    return () => {
      mounted.current = false
      epoch.current++
      window.removeEventListener('pageshow', onPageShow)
      data.subscription.unsubscribe()
    }
  }, [client])
  async function decide(action: 'approve' | 'revoke', retry = false) {
    if (flight.current || busy || closing.current || !view) return
    if (retry && (!pending || !readAfterUnknown)) return
    let body: OwnerConsentDecision
    try {
      body =
        retry && pending
          ? pending
          : buildOwnerConsentDecision(
              view,
              selected,
              action,
              confirmed,
              crypto.randomUUID(),
            )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '请确认本次操作。')
      return
    }
    try {
      savePendingOwnerConsent(body)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : '无法保存请求编号，本次操作未发送。',
      )
      return
    }
    const generation = epoch.current
    flight.current = true
    setBusy(true)
    setError('')
    setConfirmed(false)
    setNotice('')
    pendingByAccount.current.set(body.expectedAccountId, body)
    try {
      await client.decide(body)
      pendingByAccount.current.set(body.expectedAccountId, null)
      clearPendingOwnerConsent(body)
      if (!mounted.current || generation !== epoch.current) return
      setPending(null)
      setReadAfterUnknown(false)
      setNotice('这次决定已记录；正在重新读取当前授权状态。')
    } catch (caught) {
      const uncertain = caught instanceof OwnerConsentError && caught.uncertain
      const unresolved = uncertain || retry
      if (!unresolved) {
        pendingByAccount.current.set(body.expectedAccountId, null)
        clearPendingOwnerConsent(body)
      }
      if (!mounted.current || generation !== epoch.current) return
      setPending(unresolved ? body : null)
      setReadAfterUnknown(false)
      if (
        caught instanceof OwnerConsentError &&
        ['SIGN_IN_REQUIRED', 'ACCOUNT_CHANGED'].includes(caught.code)
      ) {
        setView(null)
        setSelected('')
        setPending(null)
        setNeedsLogin(caught.code === 'SIGN_IN_REQUIRED')
      }
      setError(
        caught instanceof Error ? caught.message : '结果未获确认，请重新读取。',
      )
    } finally {
      flight.current = false
      if (mounted.current && !closing.current) {
        setBusy(false)
        if (
          generation !== epoch.current ||
          !pendingByAccount.current.get(body.expectedAccountId)
        )
          void load(true)
      }
    }
  }
  async function signIn() {
    setBusy(true)
    setError('')
    try {
      const url = new URL(window.location.href)
      url.searchParams.delete('code')
      url.searchParams.delete('sb_flow_id')
      url.hash = ''
      const { error } = await pjsdasSupabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: url.toString(), scopes: 'openid email profile' },
      })
      if (error) throw error
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登录未完成。')
      setBusy(false)
    }
  }
  function close() {
    closing.current = true
    epoch.current++
    const url = new URL(window.location.href)
    url.searchParams.delete('manage_access')
    url.searchParams.delete('code')
    url.searchParams.delete('sb_flow_id')
    url.hash = ''
    window.location.assign(url.toString())
  }
  const target = view?.clients.find((c) => c.id === selected)
  const blocked = busy || Boolean(pending) || !confirmed || !target
  return (
    <main className="ta-consent">
      <section className="ta-consent-panel" aria-busy={busy}>
        <div className="ta-consent-brand">
          <BrandMark size={30} /> TodayAction · 扩展管理授权
        </div>
        <h1>选择这个客户端可以管理什么</h1>
        <p>这是单独的持续访问授权。现有插件连接不会自动获得这些权限。</p>
        {busy ? <p role="status">正在核对账号与授权状态…</p> : null}
        {needsLogin ? (
          <button
            disabled={busy}
            onClick={() => void signIn()}
            className="ta-consent-primary"
          >
            使用 Google 登录 TodayAction
          </button>
        ) : null}
        {view ? (
          <>
            <div className="ta-consent-details">
              <strong>当前账号</strong>
              <div>{view.account.email ?? view.account.id}</div>
              <small>{view.account.id}</small>
            </div>
            <label style={{ display: 'block', marginTop: 20 }}>
              选择已连接客户端
              <select
                aria-label="选择已连接客户端"
                value={selected}
                disabled={busy || Boolean(pending)}
                onChange={(event) => {
                  setSelected(event.target.value)
                  setConfirmed(false)
                  setError('')
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  minHeight: 44,
                  marginTop: 8,
                }}
              >
                <option value="">请选择，不会自动授权</option>
                {view.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.id.slice(-8)}
                  </option>
                ))}
              </select>
            </label>
            {target ? (
              <div className="ta-consent-details" style={{ marginTop: 12 }}>
                <strong>{target.name}</strong>
                <div>客户端 ID：{target.id}</div>
                <div>
                  最近读取的状态：
                  {target.grant && !target.grant.revoked_at
                    ? '扩展管理已授权'
                    : '未授权或已撤销'}
                </div>
                {!target.canApprove ? (
                  <p>OAuth 连接已断开，仅可撤销已有扩展授权。</p>
                ) : null}
              </div>
            ) : null}
            <h2>权限范围 · v{view.consent.version}</h2>
            <ul>
              {view.consent.scope.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            <h2>不包含</h2>
            <ul>
              {view.consent.exclusions.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            <p>{view.consent.duration}</p>
            <label
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy || Boolean(pending) || !target}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              我已核对上述账号、客户端和权限范围，确认本次选择。
            </label>
            <div className="ta-consent-actions">
              <button
                className="ta-consent-primary"
                disabled={blocked || !target?.canApprove}
                onClick={() => void decide('approve')}
              >
                授权这个客户端
              </button>
              <button
                disabled={
                  blocked || !target?.grant || Boolean(target.grant.revoked_at)
                }
                onClick={() => void decide('revoke')}
              >
                撤销扩展管理授权
              </button>
            </div>
          </>
        ) : null}
        {pending ? (
          <div className="ta-consent-error" role="alert">
            <p>
              请求结果尚未确认。请先重新读取；不要另建授权请求。关闭页面不会撤销可能已完成的授权。
            </p>
            <div>
              操作：{pending.decision === 'approve' ? '授权' : '撤销授权'}
            </div>
            <div>客户端 ID：{pending.clientId}</div>
            <small>请求 ID：{pending.requestId}</small>
            <button
              disabled={
                busy ||
                !readAfterUnknown ||
                view?.account.id !== pending.expectedAccountId
              }
              onClick={() => void decide(pending.decision, true)}
            >
              重试同一请求
            </button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="ta-consent-error">
            {error}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        <div className="ta-consent-actions">
          <button disabled={busy} onClick={() => void load()}>
            重新读取状态
          </button>
          <button onClick={close}>返回 TodayAction</button>
        </div>
        <p className="ta-consent-note">
          返回或关闭页面不会撤销已完成的授权。授权与撤销不会替你执行投递或对外发送消息。
        </p>
      </section>
    </main>
  )
}
