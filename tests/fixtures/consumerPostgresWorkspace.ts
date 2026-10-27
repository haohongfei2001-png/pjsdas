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
