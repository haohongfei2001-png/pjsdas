import { expect, test } from '@playwright/test'

const NOW = new Date('2026-09-25T04:00:00.000Z')
const CREATED = '2026-09-20T00:00:00.000Z'

test('TSUI-05 fixed stress fixture meets warm route and tab budget', async ({ page }) => {
  test.setTimeout(90_000)
  await page.clock.setFixedTime(NOW)
  await page.goto('/pjsdas/today')
  await page.evaluate(async (created) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['opportunities', 'actions', 'scheduleNodes', 'timeline'], 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        for (let i = 0; i < 300; i += 1) tx.objectStore('opportunities').put({
          id: 'perf-posting-' + i, company: 'Company ' + (i % 40), role: 'Role ' + i,
          currentStageLabel: '待投', processStage: 'not_applied', roleType: 'core',
          participationStatus: 'active', early: false, opportunityValue: 80, fitScore: 80,
          importedAt: created,
        })
        for (let i = 0; i < 500; i += 1) tx.objectStore('actions').put({
          id: 'perf-action-' + i, kind: i % 5 === 0 ? 'prep' : 'manual', title: 'Task ' + i,
          opportunityId: 'perf-posting-' + (i % 300), estimatedMinutes: 20, leverage: 80,
          delayCost: 60, status: 'todo', createdAt: created, updatedAt: created,
        })
        for (let i = 0; i < 130; i += 1) tx.objectStore('scheduleNodes').put({
          id: 'perf-node-' + i, occurrenceId: 'perf-occurrence-' + i, version: 1,
          kind: 'interview', state: 'scheduled', constraintKind: 'employer_hard',
          temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai',
            date: new Date(Date.UTC(2026, 8, 25 + i)).toISOString().slice(0, 10),
            resolutionBasis: 'source_explicit' },
          evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
          createdAt: created, updatedAt: created,
        })
        for (let i = 0; i < 2000; i += 1) tx.objectStore('timeline').put({
          id: 'perf-fact-' + i, kind: 'application_submitted', category: 'process',
          source: 'user_action', occurredAt: new Date(Date.UTC(2026, 0, 1 + (i % 250))).toISOString(),
          recordedAt: created, title: 'Applied ' + i,
          opportunityId: 'perf-posting-' + (i % 300),
        })
      }
    })
  }, CREATED)
  await page.reload()
  await expect(page.locator('.tsui-today')).toBeVisible()
  await page.goto('/pjsdas/schedule')
  await expect(page.locator('.tsui-schedule-page')).toBeVisible()
  await expect(page.locator('.tsui-schedule-row').first()).toBeVisible()

  async function paintAfterClick(selector: string, targetSelector: string) {
    return page.evaluate(async ({ selector, targetSelector }) => {
      const button = document.querySelector<HTMLButtonElement>(selector)
      if (!button) throw new Error('Missing measured control: ' + selector)
      const start = performance.now()
      button.click()
      for (let frame = 0; frame < 120 && !document.querySelector(targetSelector); frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      if (!document.querySelector(targetSelector)) throw new Error('Target route did not render: ' + targetSelector)
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return performance.now() - start
    }, { selector, targetSelector })
  }
  await page.evaluate(() => { (window as Window & { __TSUI05_PROFILE?: boolean }).__TSUI05_PROFILE = true })
  page.on('console', (message) => { if (message.text().startsWith('TSUI05_PROFILE_')) console.log(message.text()) })
  const routes: number[] = []
  for (let i = 0; i < 22; i += 1) {
    const today = i % 2 === 0
    const value = await paintAfterClick(
      today ? '.tsui-primary-nav button:nth-child(1)' : '.tsui-primary-nav button:nth-child(3)',
      today ? '.tsui-today' : '.tsui-schedule-page',
    )
    if (i >= 2) routes.push(value)
  }
  const tabs: number[] = []
  for (let i = 0; i < 22; i += 1) {
    const index = i % 2 === 0 ? 2 : 1
    const selector = '.tsui-schedule-tabs button:nth-child(' + index + ')'
    const value = await page.evaluate(async ({ selector }) => {
      const button = document.querySelector<HTMLButtonElement>(selector)
      if (!button) throw new Error('Missing measured tab: ' + selector)
      const start = performance.now()
      button.click()
      for (let frame = 0; frame < 120 && !button.classList.contains('active'); frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      if (!button.classList.contains('active')) throw new Error('Tab did not activate: ' + selector)
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return performance.now() - start
    }, { selector })
    if (i >= 2) tabs.push(value)
  }
  const p95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1]
  const evidence = { fixture: { opportunities: 300, actions: 500, nodes: 130, history: 2000 },
    browser: await page.evaluate(() => navigator.userAgent), viewport: page.viewportSize(),
    warmRouteSamplesMs: routes.map((value) => Number(value.toFixed(2))),
    warmTabSamplesMs: tabs.map((value) => Number(value.toFixed(2))),
    warmRouteP95Ms: Number(p95(routes).toFixed(2)),
    warmTabP95Ms: Number(p95(tabs).toFixed(2)) }
  console.log('TSUI05_WARM_PERFORMANCE:' + JSON.stringify(evidence))
  expect(evidence.warmRouteP95Ms).toBeLessThanOrEqual(150)
  expect(evidence.warmTabP95Ms).toBeLessThanOrEqual(150)
})
