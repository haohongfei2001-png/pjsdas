import { expect, test, type Page } from '@playwright/test'
import type { Action, Opportunity, Prep, ProcessEvent, ScheduleNode, TimelineRecord } from '../src/model.js'
import { freezeTodayFixture } from './support/consumerFixtureClock.js'

const now = '2026-09-30T06:00:00.000Z'
const today = '2026-09-30'
const prepId = 'retirement:prep'
const applicationId = 'retirement:application'
const ordinaryId = 'retirement:ordinary'
const retiredIds = ['retirement:prep-action', 'retirement:linked-action', 'progress-action:retirement']

test.use({ timezoneId: 'UTC' })

function fixture() {
  const opportunities: Opportunity[] = [
    ['retirement:apply-job', '合成投递公司', 'not_applied', '待投递'],
    ['retirement:interview-job', '合成面试公司', 'interview', '面试中'],
    ['retirement:exam-job', '合成笔试公司', 'written_test', '笔试中'],
  ].map(([id, company, processStage, currentStageLabel]) => ({
    id, company, role: '合成岗位', processStage: processStage as Opportunity['processStage'], currentStageLabel,
    roleType: 'core', early: false, opportunityValue: 80, fitScore: 80, locallyManaged: true, importedAt: now,
  }))
  const prep: Prep[] = [{ id: prepId, title: 'Archived synthetic preparation', triggeredBy: opportunities[0].id,
    priorityLabel: '中高', sourceStatus: '进行中', estimatedMinutes: 45, createdAt: now, updatedAt: now }]
  const action = (id: string, title: string, patch: Partial<Action> = {}): Action => ({
    id, kind: 'manual', title, opportunityId: opportunities[0].id, plannedDate: today,
    estimatedMinutes: 20, leverage: 80, delayCost: 80, status: 'todo', createdAt: now, updatedAt: now, ...patch,
  })
  const arrangedTime: ScheduleNode['temporal'] = { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC',
    startAt: '2026-09-30T10:00:00.000Z', resolutionBasis: 'user_explicit' }
  const actions: Action[] = [
    action(retiredIds[0], 'Retired typed preparation', { kind: 'prep', prepId, scheduledTemporal: arrangedTime }),
    action(retiredIds[1], 'Retired preparation-linked follow-up', { kind: 'follow_up', prepId, scheduledTemporal: arrangedTime }),
    // Legacy natural-language tasks can have a shortened title; exact provenance identifies their purpose.
    action(retiredIds[2], 'Retired legacy materials', { sourceLabel: '自然语言更新' }),
    action(ordinaryId, '确认报销到账', { scheduledTemporal: arrangedTime }),
    // A real application remains usable even if a legacy row also points to Prep.
    action(applicationId, '投递合成岗位', { kind: 'apply', prepId }),
  ]
  const processEvents: ProcessEvent[] = [
    { id: 'retirement:interview-event', opportunityId: opportunities[1].id, company: opportunities[1].company,
      role: opportunities[1].role, type: 'interview_invite', occurredAt: now, timingMode: 'fixed',
      temporal: { ...arrangedTime, startAt: '2026-10-01T10:00:00.000Z', resolutionBasis: 'source_explicit' },
      source: 'manual', createdAt: now, updatedAt: now },
    { id: 'retirement:exam-event', opportunityId: opportunities[2].id, company: opportunities[2].company,
      role: opportunities[2].role, type: 'written_test_invite', occurredAt: now, timingMode: 'fixed',
      temporal: { ...arrangedTime, startAt: '2026-10-02T11:00:00.000Z', resolutionBasis: 'source_explicit' },
      source: 'manual', createdAt: now, updatedAt: now },
  ]
  const scheduleNodes: ScheduleNode[] = actions.filter(item => item.scheduledTemporal).map(item => ({
    id: `retirement:node:${item.id}`, occurrenceId: `action:${item.id}`, version: 1, opportunityId: item.opportunityId,
    kind: item.kind === 'prep' ? 'prep_trigger' : 'follow_up', state: 'scheduled', constraintKind: 'user_plan',
    temporal: item.scheduledTemporal!, relatedActionIds: [item.id], relatedPrepIds: item.prepId ? [item.prepId] : [],
    evidenceRefs: [`action:${item.id}`], sourceVersionRefs: [], createdAt: now, updatedAt: now,
  }))
  for (const event of processEvents) {
    const id = `retirement:action:${event.id}`
    actions.push(action(id, event.type === 'interview_invite' ? '参加合成面试' : '参加合成笔试', {
      kind: 'follow_up', opportunityId: event.opportunityId, processEventId: event.id, prepId,
      plannedDate: undefined, dueAt: event.temporal!.startAt, duePrecision: 'datetime', timingMode: 'fixed',
    }))
    scheduleNodes.push({ id: `retirement:node:${event.id}`, occurrenceId: `process-event:${event.id}`, version: 1,
      opportunityId: event.opportunityId, processEventId: event.id,
      kind: event.type === 'interview_invite' ? 'interview' : 'written_test', state: 'scheduled',
      constraintKind: 'employer_hard', temporal: event.temporal!, relatedActionIds: [id], relatedPrepIds: [prepId],
      evidenceRefs: [`process-event:${event.id}`], sourceVersionRefs: [], createdAt: now, updatedAt: now })
  }
  const timeline: TimelineRecord[] = [{ id: 'timeline:progress:retirement', kind: 'action_added', category: 'action',
    source: 'natural_language', occurredAt: now, recordedAt: now, title: 'Retired legacy materials',
    detail: '准备面试材料', actionId: retiredIds[2], opportunityId: opportunities[0].id }]
  return { opportunities, prep, actions, processEvents, scheduleNodes, timeline }
}

type Fixture = ReturnType<typeof fixture>
const stores = ['opportunities', 'prep', 'actions', 'processEvents', 'scheduleNodes', 'timeline'] as const

async function seed(page: Page, data: Fixture) {
  await freezeTodayFixture(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  await page.evaluate(async data => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('pjsdas')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(Object.keys(data), 'readwrite')
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
      tx.oncomplete = () => { db.close(); resolve() }
      for (const [store, records] of Object.entries(data)) for (const record of records) tx.objectStore(store).put(record)
    }
  }), data)
}

async function rawRecords(page: Page) {
  // Read IndexedDB directly, never the product projection that intentionally hides retired rows.
  return page.evaluate(async stores => new Promise<Record<string, unknown[]>>((resolve, reject) => {
    const request = indexedDB.open('pjsdas')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(stores, 'readonly')
      const reads = stores.map(store => [store, tx.objectStore(store).getAll()] as const)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
      tx.oncomplete = () => { db.close(); resolve(Object.fromEntries(reads.map(([store, read]) => [store, read.result]))) }
    }
  }), [...stores])
}

async function assertRetiredSurfacesAbsent(page: Page, data: Fixture) {
  await expect(page.locator('.prepare-context, .surface-prep-grid, .prep-graph-dock-trigger, .prep-graph-dialog, .opportunity-detail-related-prep')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(准备资产|准备图谱|Preparation|Prep Graph)(?:\s|$)/ })).toHaveCount(0)
  for (const id of retiredIds) {
    await expect(page.locator(`.tsui-task-row[data-action-id="${id}"]`)).toHaveCount(0)
    await expect(page.locator('.tsui-task-panel, .opportunity-detail-action-list, .tsui-schedule-panel')
      .getByText(data.actions.find(item => item.id === id)!.title, { exact: true })).toHaveCount(0)
  }
  await expect(page.getByText(data.prep[0].title, { exact: true })).toHaveCount(0)
}

test('retired preparation stays out of Today, Jobs and Schedule while raw records and recruiting actions survive navigation and reload', async ({ page }) => {
  const data = fixture()
  await seed(page, data)
  const before = await rawRecords(page)
  expect(before.prep).toEqual(data.prep)
  expect(before.actions).toHaveLength(data.actions.length)
  expect(before.scheduleNodes).toHaveLength(data.scheduleNodes.length)

  await page.reload()
  for (let visit = 0; visit < 2; visit++) {
    await page.locator('.tsui-primary-nav').getByRole('button', { name: '今天', exact: true }).click()
    await expect(page.locator(`.tsui-task-row[data-action-id="${ordinaryId}"]`)).toBeVisible()
    await expect(page.locator(`.tsui-task-row[data-action-id="${applicationId}"]`)).toBeVisible()
    await assertRetiredSurfacesAbsent(page, data)

    await page.locator('.tsui-primary-nav').getByRole('button', { name: '岗位库', exact: true }).click()
    await expect(page.locator('.tsui-job-open')).toHaveCount(3)
    await assertRetiredSurfacesAbsent(page, data)
    await page.locator('.tsui-job-row[data-opportunity-id="retirement:apply-job"] .tsui-job-open').click()
    const detail = page.locator('.job-detail-page')
    await expect(detail.getByRole('button', { name: '我已投递', exact: true })).toBeEnabled()
    await expect(detail.locator('.opportunity-detail-action-list')).toContainText('确认报销到账')
    await expect(detail.locator('.opportunity-detail-action-list')).toContainText('投递合成岗位')
    await assertRetiredSurfacesAbsent(page, data)
    await page.locator('.job-detail-back').click()

    await page.locator('.tsui-primary-nav').getByRole('button', { name: '日程', exact: true }).click()
    const rows = page.locator('.tsui-schedule-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.filter({ hasText: '确认报销到账' })).toBeVisible()
    await expect(rows.filter({ hasText: '合成面试公司' })).toContainText('面试')
    await expect(rows.filter({ hasText: '合成笔试公司' })).toContainText('笔试')
    for (const id of retiredIds) await expect(page.locator(`[data-schedule-entry="node:retirement:node:${id}"]`)).toHaveCount(0)
    await assertRetiredSurfacesAbsent(page, data)

    // Recruiting occurrences and their real actions remain inspectable despite legacy Prep links.
    for (const [company, kind, time, actionTitle] of [
      ['合成面试公司', '面试', '10:00', '参加合成面试'],
      ['合成笔试公司', '笔试', '11:00', '参加合成笔试'],
    ]) {
      await page.locator('.tsui-schedule-row').filter({ hasText: company }).click()
      const occurrence = page.locator('.tsui-schedule-detail')
      await expect(occurrence.getByRole('heading', { name: kind, exact: true })).toBeVisible()
      await expect(occurrence).toContainText(time)
      await expect(occurrence.locator('.tsui-schedule-job-link')).toBeEnabled()
      await occurrence.locator('.tsui-schedule-job-link').click()
      await expect(page.locator('.opportunity-detail-action-list')).toContainText(actionTitle)
      await assertRetiredSurfacesAbsent(page, data)
      await page.locator('.job-detail-back').click()
      await expect(page.locator('.tsui-schedule-row')).toHaveCount(3)
    }
    expect(await rawRecords(page)).toEqual(before)
    await page.reload()
    await expect(page.locator('.tsui-schedule-row')).toHaveCount(3)
    await assertRetiredSurfacesAbsent(page, data)
    expect(await rawRecords(page)).toEqual(before)
  }
})
