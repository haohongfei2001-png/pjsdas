import { useEffect, useMemo, useState } from 'react'
import { getAllTimelineRecords, getDiscoveryProfile, saveDiscoveryProfile } from './db.js'
import { useCloud } from './cloud/CloudContext.js'
import { discoveryFeedbackSummary } from './discoveryFeedback.js'
import type { DiscoveryProfile } from './discoveryProfile.js'
import type { OpportunityRole, TimelineRecord } from './model.js'
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

const roleTypeOptions: Array<{ value: OpportunityRole; label: string }> = [
  { value: 'core', label: '核心' },
  { value: 'backup', label: '保底' },
  { value: 'reach', label: '冲刺' },
  { value: 'lottery', label: '彩票' },
  { value: 'practice', label: '练手' },
]

const discoveryDecisionLabels: Record<NonNullable<TimelineRecord['discoveryDecision']>, string> = {
  accepted: '已接受',
  rejected: '已拒绝',
  filtered: '质量过滤',
  duplicate: '重复',
  deferred: '暂缓',
}

function formatHistoryTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

export default function DiscoveryProfileCard() {
  const cloud = useCloud()
  const [profile, setProfile] = useState<DiscoveryProfile | null>(null)
  const [targetRoles, setTargetRoles] = useState('')
  const [locations, setLocations] = useState('')
  const [mustHave, setMustHave] = useState('')
  const [mustNotHave, setMustNotHave] = useState('')
  const [strengths, setStrengths] = useState('')
  const [history, setHistory] = useState<TimelineRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    const loadHistory = async () => {
      const records = await getAllTimelineRecords()
      if (!active) return
      setHistory(records
        .filter((item) => Boolean(item.discoveryDecision))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt)))
    }

    void Promise.all([getDiscoveryProfile(), getAllTimelineRecords()]).then(([value, records]) => {
      if (!active) return
      setProfile(value)
      setTargetRoles(lines(value.targetRoleQueries))
      setLocations(lines(value.preferredLocations))
      setMustHave(lines(value.mustHave))
      setMustNotHave(lines(value.mustNotHave))
      setStrengths(lines(value.strengths))
      setHistory(records
        .filter((item) => Boolean(item.discoveryDecision))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt)))
    })

    const onWorkspaceChanged = () => { void loadHistory() }
    window.addEventListener('pjsdas:workspace-replaced', onWorkspaceChanged)
    return () => {
      active = false
      window.removeEventListener('pjsdas:workspace-replaced', onWorkspaceChanged)
    }
  }, [])

  const historySummary = useMemo(() => discoveryFeedbackSummary(history), [history])
  const recentHistory = history.slice(0, 8)

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

  function toggleRoleType(value: OpportunityRole) {
    if (!profile) return
    const current = profile.preferredRoleTypes ?? []
    setProfile({
      ...profile,
      preferredRoleTypes: current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    })
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
          <textarea value={mustHave} onChange={(event) => setMustHave(event.target.value)} placeholder={'每行一条硬要求；未从来源确认时会显示警告'} />
        </label>
        <label>
          <span>明确排除</span>
          <textarea value={mustNotHave} onChange={(event) => setMustNotHave(event.target.value)} placeholder={'每行一条；来源明确命中时不进入 ChangeSet'} />
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

        <div className="discovery-profile-field wide">
          <span>允许的岗位类型（不选 = 不限制）</span>
          <div className="role-type-options">
            {roleTypeOptions.map((item) => (
              <label className="role-type-chip" key={item.value}>
                <input
                  type="checkbox"
                  checked={(profile.preferredRoleTypes ?? []).includes(item.value)}
                  onChange={() => toggleRoleType(item.value)}
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
        </div>

        <label>
          <span>地点约束</span>
          <select
            value={profile.locationPolicy ?? 'prefer'}
            onChange={(event) => setProfile({ ...profile, locationPolicy: event.target.value as 'prefer' | 'strict' })}
          >
            <option value="prefer">偏好：不匹配时保留并警告</option>
            <option value="strict">严格：不匹配或地点未知时拦截</option>
          </select>
        </label>
        <label>
          <span>单批最多审阅岗位</span>
          <input
            type="number"
            min="1"
            max="12"
            step="1"
            value={profile.maxReviewCandidates ?? 6}
            onChange={(event) => setProfile({ ...profile, maxReviewCandidates: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>最低匹配度（0–100，可空）</span>
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={profile.minimumFitScore ?? ''}
            onChange={(event) => setProfile({ ...profile, minimumFitScore: event.target.value === '' ? undefined : Number(event.target.value) })}
          />
        </label>
        <label>
          <span>最低机会价值（0–100，可空）</span>
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={profile.minimumOpportunityValue ?? ''}
            onChange={(event) => setProfile({ ...profile, minimumOpportunityValue: event.target.value === '' ? undefined : Number(event.target.value) })}
          />
        </label>
        <label className="wide">
          <span>地点规则 / 例外</span>
          <textarea value={profile.locationNotes} onChange={(event) => setProfile({ ...profile, locationNotes: event.target.value })} placeholder="例如：通常按某个地域范围；特定城市例外可接受。严格模式只执行上面的地点列表，复杂例外仍需人工确认。" />
        </label>
        <label className="wide">
          <span>其他发现说明</span>
          <textarea value={profile.notes} onChange={(event) => setProfile({ ...profile, notes: event.target.value })} placeholder="只放长期有效、希望 ChatGPT 每次找岗位都遵守的说明。" />
        </label>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}
      <small>质量闸门会直接拦截已过期、明确关闭、命中排除条件、低于显式分数/薪资门槛或相似重复的岗位；无法从公开来源确认的事实保持未知并在审阅中提示。</small>

      <div className="discovery-history">
        <div className="discovery-history-heading">
          <div>
            <div className="eyebrow">DISCOVERY HISTORY · ROUND 3</div>
            <h3>岗位发现历史</h3>
          </div>
          <span>显式反馈会随工作区同步，用于减少重复推荐。</span>
        </div>
        <div className="discovery-history-metrics">
          <div><strong>{historySummary.accepted}</strong><span>已接受</span></div>
          <div><strong>{historySummary.rejected}</strong><span>已拒绝</span></div>
          <div><strong>{historySummary.filtered}</strong><span>质量过滤</span></div>
          <div><strong>{historySummary.duplicate}</strong><span>重复</span></div>
          <div><strong>{historySummary.deferred}</strong><span>暂缓</span></div>
        </div>
        {recentHistory.length ? (
          <div className="discovery-history-list">
            {recentHistory.map((item) => (
              <div className="discovery-history-row" key={item.id}>
                <span className={`discovery-history-badge ${item.discoveryDecision}`}>{discoveryDecisionLabels[item.discoveryDecision!]}</span>
                <div>
                  <strong>{item.company}｜{item.role}</strong>
                  {item.detail ? <small>{item.detail}</small> : null}
                </div>
                <time>{formatHistoryTime(item.occurredAt)}</time>
              </div>
            ))}
          </div>
        ) : (
          <p className="discovery-history-empty">还没有岗位发现反馈。第一次逐岗位审阅后，这里会显示接受、拒绝和质量闸门结果。</p>
        )}
      </div>
    </section>
  )
}
