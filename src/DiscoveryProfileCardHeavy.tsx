import { useEffect, useMemo, useRef, useState } from 'react'
import { getAllTimelineRecords, getDiscoveryProfile, saveDiscoveryProfile } from './db.js'
import { useCloud } from './cloud/CloudContext.js'
import { ensureAuthoritativePersistence } from './cloud/authoritativePersistence.js'
import { connectedWorkspaceAuthorityEnabled } from './cloud/connectedWorkspaceRepository.js'
import { createConnectedCommandId, executeConnectedBusinessCommand } from './cloud/authoritativeCommandClient.js'
import { discoveryFeedbackSummary } from './discoveryFeedback.js'
import { useUiLanguage } from './uiLanguage.js'
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

const roleTypeOptions: Array<{ value: OpportunityRole; zh: string; en: string }> = [
  { value: 'core', zh: '核心', en: 'Core' },
  { value: 'backup', zh: '保底', en: 'Backup' },
  { value: 'reach', zh: '冲刺', en: 'Reach' },
  { value: 'lottery', zh: '彩票', en: 'Long shot' },
  { value: 'practice', zh: '练手', en: 'Practice' },
]

const discoveryDecisionLabels: Record<NonNullable<TimelineRecord['discoveryDecision']>, [string, string]> = {
  accepted: ['已接受', 'Accepted'],
  rejected: ['已拒绝', 'Rejected'],
  filtered: ['质量过滤', 'Quality filtered'],
  duplicate: ['重复', 'Duplicate'],
  deferred: ['暂缓', 'Deferred'],
}

function formatHistoryTime(value: string, zh: boolean) {
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

export default function DiscoveryProfileCard() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
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
  const dirtyRef = useRef(false)

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

    const onWorkspaceChanged = () => {
      void loadHistory()
      if (!dirtyRef.current) void getDiscoveryProfile().then((value) => {
        if (!active || dirtyRef.current) return
        setProfile(value)
        setTargetRoles(lines(value.targetRoleQueries))
        setLocations(lines(value.preferredLocations))
        setMustHave(lines(value.mustHave))
        setMustNotHave(lines(value.mustNotHave))
        setStrengths(lines(value.strengths))
      })
    }
    window.addEventListener('pjsdas:workspace-replaced', onWorkspaceChanged)
    return () => {
      active = false
      window.removeEventListener('pjsdas:workspace-replaced', onWorkspaceChanged)
    }
  }, [])

  const historySummary = useMemo(() => discoveryFeedbackSummary(history), [history])
  const recentHistory = history.slice(0, 8)

  function clearFeedback() {
    setMessage('')
    setError('')
  }

  function editText(setter: (value: string) => void, value: string) {
    dirtyRef.current = true
    setter(value)
    clearFeedback()
  }

  function updateProfile(patch: Partial<DiscoveryProfile>) {
    dirtyRef.current = true
    setProfile((current) => current ? { ...current, ...patch } : current)
    clearFeedback()
  }

  async function save() {
    if (!profile) return
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const requested = {
        ...profile,
        targetRoleQueries: parseLines(targetRoles),
        preferredLocations: parseLines(locations),
        mustHave: parseLines(mustHave),
        mustNotHave: parseLines(mustNotHave),
        strengths: parseLines(strengths),
      }
      let next: DiscoveryProfile
      const connected = connectedWorkspaceAuthorityEnabled() && Boolean(cloud.session)
      if (connected) {
        const accountKey = cloud.session!.user.id
        const result = await executeConnectedBusinessCommand(accountKey, {
          type: 'discovery_profile', value: requested,
        }, { commandId: createConnectedCommandId('discovery-profile') })
        if (result.outcome !== 'COMMITTED' && result.outcome !== 'ALREADY_APPLIED') {
          throw new Error(result.conflict?.message ?? '岗位发现偏好未写入账号工作区。')
        }
        next = await getDiscoveryProfile()
      } else next = await saveDiscoveryProfile(requested)
      setProfile(next)
      setTargetRoles(lines(next.targetRoleQueries))
      setLocations(lines(next.preferredLocations))
      setMustHave(lines(next.mustHave))
      setMustNotHave(lines(next.mustNotHave))
      setStrengths(lines(next.strengths))
      dirtyRef.current = false
      if (connected) {
        setMessage(zh ? '岗位发现偏好已保存到账号工作区。' : 'Job-discovery preferences saved to the account workspace.')
      } else if (cloud.session && !cloud.checkpoint.conflict) {
        try {
          await ensureAuthoritativePersistence(true, cloud.syncNow)
          setMessage(zh ? '岗位发现偏好已保存并请求同步到 Google Drive。' : 'Job-discovery preferences saved and Google Drive sync requested.')
        } catch {
          setMessage(zh ? '岗位发现偏好已保存到本机；Google Drive 暂未同步。' : 'Job-discovery preferences saved locally; Google Drive sync did not complete.')
        }
      } else {
        setMessage(zh ? '岗位发现偏好已保存到本机。' : 'Job-discovery preferences saved locally.')
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
    updateProfile({
      preferredRoleTypes: current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    })
  }

  if (!profile) return <div className="discovery-profile-card">{zh ? '正在读取岗位发现偏好…' : 'Loading job-discovery preferences…'}</div>

  return (
    <section className="discovery-profile-card">
      <div className="discovery-profile-heading">
        <div>
          <div className="eyebrow">AI JOB DISCOVERY</div>
          <h2>{zh ? '岗位发现偏好' : 'Job discovery preferences'}</h2>
          <p>{zh
            ? '这是 ChatGPT 长期寻找岗位时使用的显式约束。PJSDAS 不会从聊天记录里静默推断或改写这些偏好。'
            : 'These are the explicit constraints used for ongoing job discovery. PJSDAS never silently infers or rewrites them from chat history.'}</p>
        </div>
        <button className="primary-button" disabled={busy} onClick={() => { void save() }}>
          {busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存偏好' : 'Save preferences')}
        </button>
      </div>

      <div className="discovery-profile-grid">
        <label>
          <span>{zh ? '目标岗位 / 搜索词' : 'Target roles / search queries'}</span>
          <textarea value={targetRoles} onChange={(event) => editText(setTargetRoles, event.target.value)} placeholder={zh ? '例如：AI 产品经理\n商业分析\n项目管理' : 'For example:\nAI Product Manager\nBusiness Analysis\nProgram Management'} />
        </label>
        <label>
          <span>{zh ? '可接受地点' : 'Preferred locations'}</span>
          <textarea value={locations} onChange={(event) => editText(setLocations, event.target.value)} placeholder={zh ? '例如：北京\n上海\n深圳' : 'For example:\nBeijing\nShanghai\nShenzhen'} />
        </label>
        <label>
          <span>{zh ? '必须满足' : 'Must have'}</span>
          <textarea value={mustHave} onChange={(event) => editText(setMustHave, event.target.value)} placeholder={zh ? '每行一条硬要求；未从来源确认时会显示警告' : 'One hard requirement per line; unverified source facts stay explicit.'} />
        </label>
        <label>
          <span>{zh ? '明确排除' : 'Exclude'}</span>
          <textarea value={mustNotHave} onChange={(event) => editText(setMustNotHave, event.target.value)} placeholder={zh ? '每行一条；来源明确命中时不进入 ChangeSet' : 'One exclusion per line; confirmed matches are filtered before ChangeSet review.'} />
        </label>
        <label>
          <span>{zh ? '可用于判断匹配度的个人优势' : 'Strengths used for fit assessment'}</span>
          <textarea value={strengths} onChange={(event) => editText(setStrengths, event.target.value)} placeholder={zh ? '只写你希望长期用于岗位发现的事实或能力' : 'Include only facts or strengths you want reused in ongoing discovery.'} />
        </label>
        <label>
          <span>{zh ? '最低年薪（万元，可空）' : 'Minimum annual compensation (10k CNY, optional)'}</span>
          <input
            type="number"
            min="0"
            max="1000"
            step="1"
            value={profile.minimumAnnualCompensationWan ?? ''}
            onChange={(event) => updateProfile({
              minimumAnnualCompensationWan: event.target.value === '' ? undefined : Number(event.target.value),
            })}
          />
        </label>

        <div className="discovery-profile-field wide">
          <span>{zh ? '允许的岗位类型（不选 = 不限制）' : 'Allowed role types (none selected = unrestricted)'}</span>
          <div className="role-type-options">
            {roleTypeOptions.map((item) => (
              <label className="role-type-chip" key={item.value}>
                <input
                  type="checkbox"
                  checked={(profile.preferredRoleTypes ?? []).includes(item.value)}
                  onChange={() => toggleRoleType(item.value)}
                />
                <span>{zh ? item.zh : item.en}</span>
              </label>
            ))}
          </div>
        </div>

        <label>
          <span>{zh ? '地点约束' : 'Location policy'}</span>
          <select
            value={profile.locationPolicy ?? 'prefer'}
            onChange={(event) => updateProfile({ locationPolicy: event.target.value as 'prefer' | 'strict' })}
          >
            <option value="prefer">{zh ? '偏好：不匹配时保留并警告' : 'Prefer: keep mismatches and flag them'}</option>
            <option value="strict">{zh ? '严格：不匹配或地点未知时拦截' : 'Strict: block mismatches or unknown locations'}</option>
          </select>
        </label>
        <label>
          <span>{zh ? '单批最多审阅岗位' : 'Maximum jobs per review batch'}</span>
          <input
            type="number"
            min="1"
            max="12"
            step="1"
            value={profile.maxReviewCandidates ?? 6}
            onChange={(event) => updateProfile({ maxReviewCandidates: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>{zh ? '最低匹配度（0–100，可空）' : 'Minimum fit score (0–100, optional)'}</span>
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={profile.minimumFitScore ?? ''}
            onChange={(event) => updateProfile({ minimumFitScore: event.target.value === '' ? undefined : Number(event.target.value) })}
          />
        </label>
        <label>
          <span>{zh ? '最低机会价值（0–100，可空）' : 'Minimum opportunity value (0–100, optional)'}</span>
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={profile.minimumOpportunityValue ?? ''}
            onChange={(event) => updateProfile({ minimumOpportunityValue: event.target.value === '' ? undefined : Number(event.target.value) })}
          />
        </label>
        <label className="wide">
          <span>{zh ? '地点规则 / 例外' : 'Location rules / exceptions'}</span>
          <textarea value={profile.locationNotes} onChange={(event) => updateProfile({ locationNotes: event.target.value })} placeholder={zh ? '例如：通常按某个地域范围；特定城市例外可接受。严格模式只执行上面的地点列表，复杂例外仍需人工确认。' : 'For example: use a normal geographic range, with explicit city exceptions. Strict mode enforces the list above; complex exceptions remain explicit.'} />
        </label>
        <label className="wide">
          <span>{zh ? '其他发现说明' : 'Other discovery instructions'}</span>
          <textarea value={profile.notes} onChange={(event) => updateProfile({ notes: event.target.value })} placeholder={zh ? '只放长期有效、希望 ChatGPT 每次找岗位都遵守的说明。' : 'Keep only durable instructions you want every discovery run to follow.'} />
        </label>
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}
      <small>{zh
        ? '质量闸门会直接拦截已过期、明确关闭、命中排除条件、低于显式分数/薪资门槛或相似重复的岗位；无法从公开来源确认的事实保持未知并在审阅中提示。'
        : 'The quality gate blocks expired or closed postings, explicit exclusions, jobs below configured score/compensation thresholds, and likely duplicates. Facts that cannot be verified from public sources remain unknown and visible in review.'}</small>

      <div className="discovery-history">
        <div className="discovery-history-heading">
          <div>
            <div className="eyebrow">DISCOVERY HISTORY</div>
            <h3>{zh ? '岗位发现历史' : 'Job discovery history'}</h3>
          </div>
          <span>{zh ? '显式反馈会随工作区同步，用于减少重复推荐。' : 'Explicit feedback syncs with the workspace and helps reduce repeated recommendations.'}</span>
        </div>
        <div className="discovery-history-metrics">
          <div><strong>{historySummary.accepted}</strong><span>{zh ? '已接受' : 'Accepted'}</span></div>
          <div><strong>{historySummary.rejected}</strong><span>{zh ? '已拒绝' : 'Rejected'}</span></div>
          <div><strong>{historySummary.filtered}</strong><span>{zh ? '质量过滤' : 'Filtered'}</span></div>
          <div><strong>{historySummary.duplicate}</strong><span>{zh ? '重复' : 'Duplicate'}</span></div>
          <div><strong>{historySummary.deferred}</strong><span>{zh ? '暂缓' : 'Deferred'}</span></div>
        </div>
        {recentHistory.length ? (
          <div className="discovery-history-list">
            {recentHistory.map((item) => (
              <div className="discovery-history-row" key={item.id}>
                <span className={`discovery-history-badge ${item.discoveryDecision}`}>{discoveryDecisionLabels[item.discoveryDecision!][zh ? 0 : 1]}</span>
                <div>
                  <strong>{item.company}｜{item.role}</strong>
                  {item.detail ? <small>{item.detail}</small> : null}
                </div>
                <time>{formatHistoryTime(item.occurredAt, zh)}</time>
              </div>
            ))}
          </div>
        ) : (
          <p className="discovery-history-empty">{zh
            ? '还没有岗位发现反馈。第一次逐岗位审阅后，这里会显示接受、拒绝和质量闸门结果。'
            : 'No discovery feedback yet. After the first job-by-job review, accepted, rejected, and quality-gate outcomes will appear here.'}</p>
        )}
      </div>
    </section>
  )
}
