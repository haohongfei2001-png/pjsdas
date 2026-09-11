import { useEffect, useState } from 'react'
import { getDiscoveryProfile, saveDiscoveryProfile } from './db.js'
import { useCloud } from './cloud/CloudContext.js'
import type { DiscoveryProfile } from './discoveryProfile.js'
import './discoveryProfile.css'

function lines(values: string[]) {
  return values.join('\n')
}

function parseLines(value: string) {
  return value
    .split(/\n|，|,/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export default function DiscoveryProfileCard() {
  const cloud = useCloud()
  const [profile, setProfile] = useState<DiscoveryProfile | null>(null)
  const [targetRoles, setTargetRoles] = useState('')
  const [locations, setLocations] = useState('')
  const [mustHave, setMustHave] = useState('')
  const [mustNotHave, setMustNotHave] = useState('')
  const [strengths, setStrengths] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void getDiscoveryProfile().then((value) => {
      if (!active) return
      setProfile(value)
      setTargetRoles(lines(value.targetRoleQueries))
      setLocations(lines(value.preferredLocations))
      setMustHave(lines(value.mustHave))
      setMustNotHave(lines(value.mustNotHave))
      setStrengths(lines(value.strengths))
    })
    return () => { active = false }
  }, [])

  async function save() {
    if (!profile) return
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const next = await saveDiscoveryProfile({
        ...profile,
        targetRoleQueries: parseLines(targetRoles),
        preferredLocations: parseLines(locations),
        mustHave: parseLines(mustHave),
        mustNotHave: parseLines(mustNotHave),
        strengths: parseLines(strengths),
      })
      setProfile(next)
      setTargetRoles(lines(next.targetRoleQueries))
      setLocations(lines(next.preferredLocations))
      setMustHave(lines(next.mustHave))
      setMustNotHave(lines(next.mustNotHave))
      setStrengths(lines(next.strengths))
      window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
      if (cloud.session && !cloud.checkpoint.conflict) {
        try {
          await cloud.syncNow()
          setMessage('岗位发现偏好已保存并请求同步到 Google Drive。')
        } catch {
          setMessage('岗位发现偏好已保存到本机；Google Drive 暂未同步。')
        }
      } else {
        setMessage('岗位发现偏好已保存到本机。')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!profile) return <div className="discovery-profile-card">正在读取岗位发现偏好…</div>

  return (
    <section className="discovery-profile-card">
      <div className="discovery-profile-heading">
        <div>
          <div className="eyebrow">AI JOB DISCOVERY · V1.3</div>
          <h2>岗位发现偏好</h2>
          <p>这是 ChatGPT 长期寻找岗位时使用的显式约束。PJSDAS 不会从聊天记录里静默推断或改写这些偏好。</p>
        </div>
        <button className="primary-button" disabled={busy} onClick={() => { void save() }}>
          {busy ? '保存中…' : '保存偏好'}
        </button>
      </div>

      <div className="discovery-profile-grid">
        <label>
          <span>目标岗位 / 搜索词</span>
          <textarea value={targetRoles} onChange={(event) => setTargetRoles(event.target.value)} placeholder={'例如：AI 产品经理\n商业分析\n项目管理'} />
        </label>
        <label>
          <span>可接受地点</span>
          <textarea value={locations} onChange={(event) => setLocations(event.target.value)} placeholder={'例如：北京\n上海\n深圳'} />
        </label>
        <label>
          <span>必须满足</span>
          <textarea value={mustHave} onChange={(event) => setMustHave(event.target.value)} placeholder={'每行一条硬要求；不确定时宁可留空'} />
        </label>
        <label>
          <span>明确排除</span>
          <textarea value={mustNotHave} onChange={(event) => setMustNotHave(event.target.value)} placeholder={'每行一条排除条件'} />
        </label>
        <label>
          <span>可用于判断匹配度的个人优势</span>
          <textarea value={strengths} onChange={(event) => setStrengths(event.target.value)} placeholder={'只写你希望长期用于岗位发现的事实或能力'} />
        </label>
        <label>
          <span>最低年薪（万元，可空）</span>
          <input
            type="number"
            min="0"
            max="1000"
            step="1"
            value={profile.minimumAnnualCompensationWan ?? ''}
            onChange={(event) => setProfile({
              ...profile,
              minimumAnnualCompensationWan: event.target.value === '' ? undefined : Number(event.target.value),
            })}
          />
        </label>
        <label className="wide">
          <span>地点规则 / 例外</span>
          <textarea value={profile.locationNotes} onChange={(event) => setProfile({ ...profile, locationNotes: event.target.value })} placeholder="例如：通常按某个地域范围；特定城市例外可接受。" />
        </label>
        <label className="wide">
          <span>其他发现说明</span>
          <textarea value={profile.notes} onChange={(event) => setProfile({ ...profile, notes: event.target.value })} placeholder="只放长期有效、希望 ChatGPT 每次找岗位都遵守的说明。" />
        </label>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}
      <small>ChatGPT 当前会把这里的内容当作发现约束；实时岗位事实仍必须来自公开招聘页面，而不是由模型补全。</small>
    </section>
  )
}
