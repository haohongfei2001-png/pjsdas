import { createSnapshot } from '../../src/snapshot.js'

/** A signed synthetic identity must also identify the isolated mock issuer. */
export function consumerAuthClaims(accountKey: string) {
  return { role: 'authenticated', sub: accountKey, iss: 'https://todayaction-auth.invalid/auth/v1' }
}

/** Initial business data only. Commands, journals and receipts are never seeded. */
export function consumerPostgresWorkspace(now = new Date()) {
  const at = now.toISOString(), day = at.slice(0, 10)
  return createSnapshot({ opportunities: [], processes: [], processEvents: [], prep: [], applicationGroups: [], timeline: [],
    actions: ['consumer-task', 'unrelated-task'].map(id => ({ id, kind: 'manual' as const,
      title: id === 'consumer-task' ? 'Synthetic browser recovery task' : 'Synthetic unrelated task',
      estimatedMinutes: 10, leverage: id === 'consumer-task' ? 90 : 50, delayCost: 50,
      status: 'todo' as const, plannedDate: day, createdAt: at, updatedAt: at })),
    timePlanning: { version: 1 as const, defaultDailyMinutes: 360, dateOverrides: { [day]: 360 }, updatedAt: at },
  }, at)
}

/** Small, already-read business facts only. No command/receipt/locator seed. */
export function consumerStopFollowingWorkspace(now = new Date()) {
  const base = consumerPostgresWorkspace(now), at = now.toISOString()
  const job = { id: 'consumer-stop-job', company: 'Synthetic stop company', role: 'Synthetic analyst',
    currentStageLabel: '筛选中', processStage: 'screening' as const, roleType: 'core' as const,
    participationStatus: 'active' as const, early: false, opportunityValue: 50, fitScore: 50,
    locallyManaged: true, importedAt: at, discoveryRead: { version: 1 as const, addedAt: at, viewedAt: at } }
  return createSnapshot({ ...base.data, opportunities: [job, { ...job, id: 'consumer-other-job', company: 'Synthetic retained company' }],
    processes: [{ id: 'consumer-stop-process', opportunityId: job.id, company: job.company, role: job.role,
      stage: 'screening', stageLabel: '筛选中', progress: 'waiting_result', result: 'pending', participationState: 'active', locallyManaged: true }],
    processEvents: [{ id: 'consumer-retained-event', opportunityId: job.id, company: job.company, role: job.role,
      type: 'status_update', source: 'email', notes: 'Synthetic recruiter screening update', occurredAt: at, createdAt: at, updatedAt: at }],
    actions: [...base.data.actions, ...(['todo', 'doing', 'done'] as const).map(status => ({
      id: `consumer-stop-${status}`, kind: 'manual' as const, opportunityId: job.id,
      title: `Synthetic stop ${status}`, status, estimatedMinutes: 10, leverage: 10, delayCost: 10,
      createdAt: at, updatedAt: at,
    }))],
    timeline: [{ id: 'consumer-retained-history', kind: 'opportunity_updated', category: 'opportunity',
      source: 'user_action', title: 'Synthetic prior recruiting history', opportunityId: job.id,
      occurredAt: at, recordedAt: at }],
  }, at)
}
