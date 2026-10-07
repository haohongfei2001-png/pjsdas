import { buildApplicationPortfolioDecision } from './applicationPortfolio.js'
import { useEffect, useState } from 'react'
import { exportLocalSnapshot } from './db.js'
import { resolveApplicationDeadline, type ResolvedApplicationDeadline } from './applicationDeadline.js'
import type { ApplicationGroup, Opportunity } from './model.js'
import { presentStageLabel } from './stagePresentation.js'
import { useUiLanguage } from './uiLanguage.js'
import './applicationPortfolio.css'

function roleTypeLabel(value: Opportunity['roleType'], zh: boolean) {
  const labels = {
    core: zh ? '核心' : 'Core',
    backup: zh ? '保底' : 'Backup',
    reach: zh ? '冲刺' : 'Reach',
    lottery: zh ? '彩票' : 'Lottery',
    practice: zh ? '练手' : 'Practice',
  }
  return value ? labels[value] : (zh ? '未分类' : 'Unclassified')
}

export default function ApplicationPortfolioDock() {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [groups, setGroups] = useState<ApplicationGroup[]>([])
  const [opportunities, setOpportunities] = useState<Array<Opportunity & { deadlineResolution: ResolvedApplicationDeadline }>>([])
  const [error, setError] = useState('')

  async function reload() {
    setLoading(true)
    setError('')
    try {
      const snapshot = await exportLocalSnapshot()
      setGroups(snapshot.data.applicationGroups)
      setOpportunities(snapshot.data.opportunities.map(item => {
        const resolved = resolveApplicationDeadline(item, snapshot.data)
        return { ...item, deadlineResolution: resolved }
      }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally { setLoading(false) }
  }

  useEffect(() => { if (open) void reload() }, [open])
  useEffect(() => {
    const handler = () => { if (open) void reload() }
    window.addEventListener('pjsdas:workspace-replaced', handler)
    return () => window.removeEventListener('pjsdas:workspace-replaced', handler)
  }, [open])

  return <>
    <button className="portfolio-dock-trigger" type="button" onClick={() => setOpen(true)}>{zh ? '申请名额' : 'Application quotas'}</button>
    {open ? <div className="portfolio-backdrop" onMouseDown={() => setOpen(false)}>
      <section className="portfolio-dialog" role="dialog" aria-modal="true" aria-label={zh ? '申请名额' : 'Application quotas'} onMouseDown={(event) => event.stopPropagation()}>
        <header className="portfolio-header">
          <div><div className="eyebrow">APPLICATION QUOTAS</div><h2>{zh ? '申请名额与志愿记录' : 'Application quotas and preferences'}</h2><p>{zh ? '查看已记录的公司名额、志愿顺序与关联岗位。岗位仅按截止时间排列。' : 'View recorded company quotas, preference order, and associated jobs. Jobs are ordered only by deadline.'}</p></div>
          <button className="portfolio-close" type="button" onClick={() => setOpen(false)} aria-label={zh ? '关闭' : 'Close'}>×</button>
        </header>
        <div className="portfolio-safety"><strong>{zh ? '只读记录' : 'Read-only records'}</strong><span>{zh ? '这里不会修改志愿、占用名额或提交申请。' : 'This view does not change preferences, consume quota, or submit applications.'}</span><button type="button" disabled={loading} onClick={() => { void reload() }}>{loading ? '…' : (zh ? '刷新' : 'Refresh')}</button></div>
        {error ? <div className="portfolio-notice error">{error}</div> : null}
        {!loading && !groups.length ? <div className="portfolio-empty"><strong>{zh ? '当前没有结构化申请组' : 'No structured application groups'}</strong><p>{zh ? '只有明确关联的岗位才显示在申请组内；不会仅凭同一家公司推断名额规则。' : 'Only explicitly associated jobs appear in a group. Quota rules are not inferred from company identity alone.'}</p></div> : null}
        <div className="portfolio-groups">{groups.map((group) => {
          const byId = new Map(opportunities.map(item => [item.id, item]))
          const candidates = buildApplicationPortfolioDecision(group, opportunities, undefined, new Date(),
            Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').candidates
            .map(item => ({ ...byId.get(item.opportunityId)!, deadline: item.deadline }))
          const remaining = group.remaining ?? (group.total !== undefined && group.used !== undefined ? Math.max(0, group.total - group.used) : undefined)
          const inconsistent = group.remaining !== undefined && group.total !== undefined && group.used !== undefined && group.remaining !== Math.max(0, group.total - group.used)
          return <article className="portfolio-group" key={group.id}>
            <div className="portfolio-group-head"><div>{group.locked ? <span className="portfolio-status">{zh ? '已锁定' : 'Locked'}</span> : null}<h3>{group.company}</h3><small>{group.id}</small></div><div className="portfolio-capacity"><span>{zh ? '剩余名额' : 'Remaining quota'}</span><strong>{remaining ?? '?'}</strong><small>{zh ? `总 ${group.total ?? '?'} · 已用 ${group.used ?? '?'}` : `total ${group.total ?? '?'} · used ${group.used ?? '?'}`}</small></div></div>
            <div className="portfolio-source-rule">
              {group.rule ? <span><b>{zh ? '名额规则' : 'Quota rule'}：</b>{group.rule}</span> : null}
              {group.currentOrder ? <span><b>{zh ? '已记录志愿' : 'Recorded preference'}：</b>{group.currentOrder}</span> : null}
              {group.coveredRoles ? <span><b>{zh ? '覆盖岗位' : 'Covered roles'}：</b>{group.coveredRoles}</span> : null}
              {group.notes ? <span>{group.notes}</span> : null}
            </div>
            {inconsistent ? <div className="portfolio-warnings">{zh ? '总名额、已用名额与剩余名额不一致，请核对来源。' : 'Total, used, and remaining quota are inconsistent; check the source.'}</div> : null}
            {remaining === undefined ? <div className="portfolio-warnings">{zh ? '剩余名额尚未明确。' : 'Remaining quota is not stated.'}</div> : null}
            <section className="portfolio-section"><div className="portfolio-section-title"><strong>{zh ? `关联岗位 · ${candidates.length} 个` : `Associated jobs · ${candidates.length}`}</strong><span>{zh ? '按截止时间' : 'By deadline'}</span></div>
              <div className="portfolio-candidate-list">{candidates.map((candidate) => <article className="portfolio-candidate" key={candidate.id}>
                <div className="portfolio-candidate-head"><div><strong>{candidate.role}</strong><span>{roleTypeLabel(candidate.roleType, zh)} · {presentStageLabel(candidate.processStage, undefined, lang)}</span></div></div>
                <div className="portfolio-candidate-reason"><span>{zh ? '申请截止' : 'Application deadline'}：{candidate.deadline ?? (zh ? '未明确' : 'Not stated')}</span>{candidate.order !== undefined ? <span>{zh ? '已记录志愿序号' : 'Recorded preference position'}：{candidate.order}</span> : null}</div>
              </article>)}</div>
            </section>
          </article>
        })}</div>
      </section>
    </div> : null}
  </>
}
