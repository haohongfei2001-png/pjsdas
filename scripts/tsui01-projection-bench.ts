import { performance } from 'node:perf_hooks'
import type { Action, Opportunity, ScheduleNode, TimelineRecord } from '../src/model.js'
import { createSnapshot } from '../src/snapshot.js'
import { buildTodayBrief } from '../src/todayBrief.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import { buildScheduleStream, readScheduleWindow } from '../src/schedule/scheduleStream.js'

const now = new Date('2026-09-25T04:00:00.000Z')
const at = '2026-09-20T00:00:00.000Z'
const opportunities: Opportunity[] = Array.from({ length: 300 }, (_, i) => ({
  id: `posting-${i}`, company: `Company ${i % 40}`, role: `Role ${i}`,
  currentStageLabel: '待投', processStage: 'not_applied', roleType: 'core',
  participationStatus: 'active', early: false, opportunityValue: 80, fitScore: 80, importedAt: at,
}))
const actions: Action[] = Array.from({ length: 500 }, (_, i) => ({
  id: `action-${i}`, kind: i % 5 === 0 ? 'prep' : 'manual', title: `Task ${i}`,
  opportunityId: `posting-${i % 300}`, estimatedMinutes: 20, leverage: 80, delayCost: 60,
  status: 'todo', createdAt: at, updatedAt: at,
}))
const nodes: ScheduleNode[] = Array.from({ length: 130 }, (_, i) => ({
  id: `node-${i}`, occurrenceId: `occurrence-${i}`, version: 1, kind: 'interview', state: 'scheduled',
  temporal: {
    shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai',
    date: new Date(Date.UTC(2026, 8, 25 + i)).toISOString().slice(0, 10), resolutionBasis: 'source_explicit',
  },
  constraintKind: 'employer_hard', evidenceRefs: [], sourceVersionRefs: [],
  relatedActionIds: [], relatedPrepIds: [], createdAt: at, updatedAt: at,
}))
const timeline: TimelineRecord[] = Array.from({ length: 2000 }, (_, i) => ({
  id: `fact-${i}`, kind: 'application_submitted', category: 'process', source: 'user_action',
  occurredAt: new Date(Date.UTC(2026, 0, 1 + (i % 250))).toISOString(),
  recordedAt: at, title: `Applied ${i}`, opportunityId: `posting-${i % 300}`,
}))
const snapshot = createSnapshot({
  opportunities, processes: [], processEvents: [], actions, scheduleNodes: nodes,
  prep: [], applicationGroups: [], timeline, changeSets: [], decisionRequests: [], semanticReceipts: [],
}, now.toISOString())
const context = { now, timezone: 'Asia/Shanghai', workspaceVersion: 'bench-r1' }
const scheduleContext = { accountKey: 'synthetic-account', workspaceRevision: 'bench-r1', timezone: 'Asia/Shanghai', now }

function measure(label: string, run: () => void) {
  const samples: number[] = []
  for (let i = 0; i < 12; i += 1) {
    const start = performance.now()
    run()
    if (i >= 2) samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return { label, p50Ms: Number(samples[4].toFixed(2)), p95Ms: Number(samples[9].toFixed(2)) }
}

const baseline = measure('existing TodayBrief v1', () => { buildTodayBrief(snapshot, {}, context) })
const today = measure('complete Today Web selector', () => { selectTodayWeb(snapshot, {}, context) })
const schedule = measure('ScheduleStream full projection', () => { buildScheduleStream(snapshot, scheduleContext) })
const stream = buildScheduleStream(snapshot, scheduleContext)
const append = measure('indexed 30-row append', () => {
  const first = readScheduleWindow(stream, 'history', 30)
  readScheduleWindow(stream, 'history', 30, first.nextCursor)
})
console.log(JSON.stringify({
  fixture: { opportunities: 300, nodes: 130, actions: 500, history: 2000 },
  runtime: process.version, platform: process.platform, arch: process.arch,
  counts: stream.counts,
  measurements: [baseline, today, schedule, append],
}, null, 2))
