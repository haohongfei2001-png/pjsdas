import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deadlineWorkspace, LATE_NOW } from '../tests/fixtures/postZmcDeadlineWorkspace.js'

test.use({ timezoneId: 'Asia/Shanghai' })
test('legacy UTC deadlines display the same local instant in Today, Schedule and job detail', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-30T07:39:00Z') })
  await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  await page.evaluate(async input => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(input), deadlineWorkspace(500))
  await page.goto('/pjsdas/today')
  await expect(page.locator('[data-action-id="apply-0"]')).toContainText('23:59')
  await expect(page.locator('.tsui-node-row').first()).toContainText('23:59')
  await page.goto('/pjsdas/schedule')
  await expect(page.locator('.tsui-schedule-row').first()).toContainText('23:59')
  await page.goto('/pjsdas/opportunities/job-0')
  await expect(page.locator('.opportunity-detail-primary-operation')).toContainText('23:59')
  await expect(page.locator('.opportunity-detail-nearest-node')).toContainText('23:59')
})

test('deadline subset survives a full browser restart with the same retained IndexedDB', async ({ browser }) => {
  const profile = await mkdtemp(join(tmpdir(), 'post-zmc-deadline-'))
  let context = await browser.browserType().launchPersistentContext(profile, { headless: true, timezoneId: 'Asia/Shanghai' })
  try {
    const page = await context.newPage()
    await page.clock.install({ time: LATE_NOW })
    await page.goto('http://127.0.0.1:4173/'); await page.locator('.tsui-primary-nav').waitFor()
    const snapshot = deadlineWorkspace()
    await page.evaluate(async input => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(input), snapshot)
    await page.goto('http://127.0.0.1:4173/pjsdas/today')
    await expect(page.locator('[data-action-id]')).toHaveCount(2)
    const ids = await page.locator('[data-action-id]').evaluateAll(items => items.map(item => item.getAttribute('data-action-id')))
    await context.close()
    context = await browser.browserType().launchPersistentContext(profile, { headless: true, timezoneId: 'Asia/Shanghai' })
    const restarted = await context.newPage()
    await restarted.clock.install({ time: LATE_NOW })
    await restarted.goto('http://127.0.0.1:4173/pjsdas/today')
    await expect(restarted.locator('[data-action-id]')).toHaveCount(2)
    expect(await restarted.locator('[data-action-id]').evaluateAll(items => items.map(item => item.getAttribute('data-action-id')))).toEqual(ids)
    const stored = await restarted.evaluate(async () => (await import('/pjsdas/src/db.ts')).exportLocalSnapshot())
    expect(stored.data.actions).toHaveLength(6)
    expect(stored.data.scheduleNodes).toHaveLength(6)
    expect(stored.data.scheduleNodes!.every(item => item.temporal.deadlineAt === '2026-09-30T15:59:59Z')).toBe(true)
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }) }
})

test('floating date stays a calendar date in all consumer surfaces', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-30T07:39:00Z') })
  await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const snapshot = deadlineWorkspace(500)
  snapshot.data.actions.forEach(item => { item.dueAt = '2026-09-30'; item.duePrecision = 'date' })
  snapshot.data.opportunities.forEach(item => { item.deadline = '2026-09-30'; item.deadlinePrecision = 'date' })
  snapshot.data.scheduleNodes!.forEach(item => { item.temporal = { shape: 'date_only', precision: 'date', date: '2026-09-30',
    timezone: 'floating-date', resolutionBasis: 'legacy_projection' } })
  await page.evaluate(async input => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(input), snapshot)
  await page.goto('/pjsdas/today')
  await expect(page.locator('[data-action-id="apply-0"]')).toContainText('2026-09-30')
  await page.goto('/pjsdas/schedule')
  await expect(page.locator('.tsui-schedule-date').first()).toContainText('2026-09-30')
  await expect(page.locator('.tsui-schedule-time').first()).toContainText('具体时间待定')
  await page.goto('/pjsdas/opportunities/job-0')
  await expect(page.locator('.opportunity-detail-nearest-node')).toContainText('2026-09-30')
})

for (const scenario of [
  { zone: 'UTC', at: '2026-09-30T15:59:59Z', expected: '15:59', basis: 'legacy_projection' as const, source: 'UTC' },
  { zone: 'America/New_York', at: '2026-03-08T07:30:00Z', expected: '03:30', basis: 'legacy_projection' as const, source: 'UTC' },
  { zone: 'America/New_York', at: '2026-11-01T06:30:00Z', expected: '01:30', basis: 'legacy_projection' as const, source: 'UTC' },
  { zone: 'Asia/Shanghai', at: '2026-09-30T15:59:59Z', expected: '11:59', basis: 'source_explicit' as const, source: 'America/New_York' },
]) test(`Schedule respects ${scenario.basis} in ${scenario.zone} at ${scenario.at}`, async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: scenario.zone })
  try {
    const page = await context.newPage()
    await page.clock.install({ time: new Date(Date.parse(scenario.at) - 12 * 3_600_000) })
    await page.goto('http://127.0.0.1:4173/'); await page.locator('.tsui-primary-nav').waitFor()
    const snapshot = deadlineWorkspace(500, scenario.at)
    snapshot.data.scheduleNodes!.forEach(item => { item.temporal.timezone = scenario.source; item.temporal.resolutionBasis = scenario.basis })
    await page.evaluate(async input => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(input), snapshot)
    for (const route of ['today', 'schedule', 'opportunities/job-0']) {
      await page.goto(`http://127.0.0.1:4173/pjsdas/${route}`)
      const target = route === 'today' ? '[data-action-id="apply-0"]' : route === 'schedule' ? '.tsui-schedule-row' : '.opportunity-detail-nearest-node'
      await expect(page.locator(target).first()).toContainText(scenario.expected)
      if (scenario.basis === 'source_explicit') await expect(page.locator(target).first()).toContainText('GMT-4')
    }
  } finally { await context.close() }
})

for (const scenario of [
  { label: '100 minutes and unknown capacity', capacity: undefined, now: LATE_NOW, count: 2 },
  { label: 'capacity 60 below physical time', capacity: 60, now: LATE_NOW, count: 1 },
  { label: 'capacity 500 above physical time', capacity: 500, now: LATE_NOW, count: 2 },
  { label: '500 minutes remaining', capacity: 500, now: new Date('2026-09-30T07:39:00Z'), count: 6 },
  { label: 'work crosses local midnight', capacity: undefined, now: new Date('2026-09-30T14:50:00Z'), count: 2, deadline: '2026-09-30T16:30:00Z' },
  { label: 'work uses the next-day window', capacity: 500, now: new Date('2026-09-30T14:50:00Z'), count: 2, deadline: '2026-09-30T16:30:00Z', windows: true },
]) test(`six hard deadlines: ${scenario.label}`, async ({ page }, testInfo) => {
  await page.clock.install({ time: scenario.now })
  await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const snapshot = deadlineWorkspace(scenario.capacity, scenario.deadline)
  if ('windows' in scenario && scenario.windows) snapshot.data.timePlanning!.weeklyWindows = [
    { weekday: 3, startMinute: 1370, endMinute: 1440 }, { weekday: 4, startMinute: 0, endMinute: 60 },
  ]
  await page.evaluate(async input => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(input), snapshot)
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-task-panel [data-action-id]')).toHaveCount(scenario.count)
  if (scenario.count < 6) {
    await expect(page.locator('.tsui-deadline-notice')).toContainText('申请 A')
    await expect(page.locator('.tsui-deadline-notice')).toContainText('申请 C')
    await expect(page.locator('.tsui-deadline-notice')).toContainText('未选入今天')
  } else await expect(page.locator('.tsui-deadline-notice')).toHaveCount(0)
  if (scenario.capacity === undefined && !scenario.deadline) await page.screenshot({ path: testInfo.outputPath('deadline-tradeoff.png'), fullPage: true })
  const selected = await page.locator('[data-action-id]').evaluateAll(items => items.map(item => item.getAttribute('data-action-id')))
  await page.reload()
  await expect(page.locator('.tsui-task-panel [data-action-id]')).toHaveCount(scenario.count)
  expect(await page.locator('[data-action-id]').evaluateAll(items => items.map(item => item.getAttribute('data-action-id')))).toEqual(selected)
  const stored = await page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).dbPromise).getAll('scheduleNodes'))
  expect(stored).toHaveLength(6)
  expect(stored.map(item => item.temporal.deadlineAt)).toEqual(Array(6).fill(scenario.deadline ?? '2026-09-30T15:59:59Z'))
})


test('cross-midnight hard work leaves usable time for a flexible Today task', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-30T15:30:00Z'))
  await page.goto('/'); await page.locator('.tsui-primary-nav').waitFor()
  const snapshot = deadlineWorkspace(120, '2026-09-30T17:00:00Z')
  snapshot.data.actions = snapshot.data.actions.slice(0, 2)
  snapshot.data.actions[0].estimatedMinutes = 70
  snapshot.data.actions[1] = { ...snapshot.data.actions[1], kind: 'manual', title: '整理申请材料', estimatedMinutes: 20, dueAt: undefined }
  snapshot.data.scheduleNodes = snapshot.data.scheduleNodes!.slice(0, 1)
  snapshot.data.timePlanning!.weeklyWindows = [
    { weekday: 3, startMinute: 1410, endMinute: 1440 }, { weekday: 4, startMinute: 0, endMinute: 60 },
  ]
  await page.evaluate(async input => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(input), snapshot)
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-task-panel [data-action-id]')).toHaveCount(2)
  await expect(page.locator('[data-action-id="apply-1"]')).toContainText('整理申请材料')
  await page.reload()
  await expect(page.locator('.tsui-task-panel [data-action-id]')).toHaveCount(2)
})
