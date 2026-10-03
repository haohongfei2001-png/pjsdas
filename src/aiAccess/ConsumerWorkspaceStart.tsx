import { useEffect, useRef, useState } from 'react'
import { fetchBackend } from '../backendEndpoints.js'
import { validPlanningTimezone } from '../timePlanningPreferences.js'
import { pjsdasSupabase } from './supabaseClient.js'

/** Explicit empty start. Existing server workspaces are returned, never reset. */
export default function ConsumerWorkspaceStart({ accountId }: { accountId: string }) {
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const mounted = useRef(true), flight = useRef(false), epoch = useRef(0)
  const pending = useRef<{ action: 'initialize_empty'; expectedAccountId: string; commandId: string; timezone: string; confirmStartEmpty: true } | null>(null)
  useEffect(() => { mounted.current = true; epoch.current++; pending.current = null; setConfirmed(false); setMessage(''); return () => { mounted.current = false; epoch.current++ } }, [accountId])
  async function initialize() {
    if (flight.current || !confirmed || !validPlanningTimezone(timezone)) return
    const generation = epoch.current
    flight.current = true; setBusy(true); setMessage('')
    try {
      const { data, error } = await pjsdasSupabase.auth.getSession()
      if (error || !data.session || data.session.user.id !== accountId) throw new Error('账号已变化，请重新读取后再选择。')
      const body: NonNullable<typeof pending.current> = pending.current ?? { action: 'initialize_empty', expectedAccountId: accountId, commandId: crypto.randomUUID(), timezone, confirmStartEmpty: true }
      pending.current = body
      const response = await fetchBackend('/api/workspace', { method: 'POST', headers: { authorization: `Bearer ${data.session.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(result?.code === 'AUTH_FORBIDDEN' ? '当前账号暂未开放空工作区初始化，或登录已变化。' : '工作区结果未确认。可以重试同一请求，已有工作区不会被重置。')
      const current = await pjsdasSupabase.auth.getSession()
      if (current.data.session?.user.id !== accountId) throw new Error('账号已变化，请重新读取。')
      if (!['EXISTING_WORKSPACE', 'INITIALIZED_OR_EXISTING'].includes(result?.outcome) || typeof result?.workspaceId !== 'string') throw new Error('工作区结果未确认，请重新读取。')
      pending.current = null
      if (mounted.current && epoch.current === generation) { setConfirmed(false); setMessage('工作区已准备好；已有数据不会被重置。现在可选择此客户端的分项权限。') }
    } catch (error) {
      if (mounted.current && epoch.current === generation) setMessage(error instanceof Error ? error.message : '工作区结果未确认。')
    } finally { flight.current = false; if (mounted.current) setBusy(false) }
  }
  return <section aria-label="准备工作区" aria-busy={busy}>
    <h2>第一次使用 TodayAction</h2>
    <p>可以从空工作区开始，无需连接 Gmail 或 Drive。已有 TodayAction 工作区会直接保留。</p>
    <p>如果你要沿用已有本机或 Drive 资料，请返回 TodayAction 选择迁移；这里不会导入或删除这些资料。</p>
    <label>工作区时区<input aria-label="工作区时区" value={timezone} disabled={busy || Boolean(pending.current)} onChange={event => { setTimezone(event.target.value); setConfirmed(false) }} /></label>
    <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />我明确选择从空工作区开始，并已核对当前账号及上述时区。</label>
    <button disabled={busy || !confirmed || !validPlanningTimezone(timezone)} onClick={() => void initialize()}>{pending.current ? '重试同一初始化请求' : '准备我的工作区'}</button>
    {message ? <p role="status">{message}</p> : null}
  </section>
}
