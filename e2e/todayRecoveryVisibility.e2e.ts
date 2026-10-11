import { expect, test, type Page } from '@playwright/test'
import { createSnapshot } from '../src/snapshot.js'
import { actionForProcessEvent } from '../src/processEvents.js'
import { action, opportunity } from './fixtures/todayWorkspace.js'
import type { ProcessEvent } from '../src/model.js'

const NOW = new Date('2026-10-11T08:00:00Z')
test.use({ timezoneId: 'UTC' })
async function read(page: Page) {
  return page.evaluate(async () => (await import('/pjsdas/src/db.ts')).exportLocalSnapshot())
}
function fixture(minutes: number) {
  const jobs = ['old', 'today'].map(id => ({ ...opportunity(`job-${id}`, `Company ${id}`, `Role ${id}`), processStage: 'assessment' as const }))
  const events: ProcessEvent[] = jobs.map((job, i) => ({ id: i ? 'today' : 'old', opportunityId: job.id, company: job.company, role: job.role,
    type: 'assessment_invite', source: 'email', occurredAt: '2026-09-01T00:00:00Z', dueAt: i ? '2026-10-11T09:00:00Z' : '2026-09-27T09:00:00Z',
    duePrecision: 'datetime', timingMode: 'deadline', estimatedMinutes: 90, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }))
  return createSnapshot({ opportunities: jobs, processEvents: events, actions: [...events.map(item => actionForProcessEvent(item)!),
    { ...action('manual', 'Prepare portfolio', undefined, 0, '2026-10-11'), estimatedMinutes: 60 },
    { ...action('small', 'Read notes', undefined, 0, '2026-10-11'), estimatedMinutes: 10 }],
    processes: [], prep: [], applicationGroups: [], timePlanning: { version: 1, dateOverrides: { '2026-10-11': minutes }, updatedAt: NOW.toISOString() },
  }, NOW.toISOString())
}

for (const minutes of [0, 56]) test(`Today ${minutes} minutes keeps tasks interactive and overdue events reviewable`, async ({ page }, info) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  // No test request may leave the local fixture server, including auth/analytics.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.addInitScript(() => localStorage.setItem('pjsdas-ui-language', 'en'))
  await page.clock.setFixedTime(NOW)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/pjsdas/today')
  await page.locator('.tsui-primary-nav').waitFor()
  await page.evaluate(async value => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(value), fixture(minutes))
  await page.goto('/pjsdas/today')
  const initial = await read(page)
  const ids = ['event-action:today', 'manual', 'small']
  for (const id of ids) await expect(page.locator(`[data-action-id="${id}"]`)).toHaveCount(1)
  await expect(page.locator('[data-action-id]')).toHaveCount(3)
  await expect(page.locator('[data-capacity-limited-action-id]')).toHaveCount(minutes ? 2 : 3)
  await expect(page.locator('[data-recovery-action-id="event-action:old"]')).toBeVisible()
  await expect(page.locator('.tsui-task-panel .tsui-count')).toHaveText('3')
  await expect(page.getByText('Nothing requires action right now', { exact: true })).toHaveCount(0)
  // Synthetic initial cards and recovery state are reviewable in artifacts and
  // plain CI logs; no production data or external network is involved.
  await info.attach(`today-recovery-${minutes}-initial`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  const visual = (await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true })).toString('base64')
  console.log(`TODAY_RECOVERY_VISUAL_${minutes}_BEGIN`)
  for (let offset = 0; offset < visual.length; offset += 3000) console.log(`TODAY_RECOVERY_VISUAL_${minutes}_DATA:${visual.slice(offset, offset + 3000)}`)
  console.log(`TODAY_RECOVERY_VISUAL_${minutes}_END`)
  // Passive rendering and recovery navigation do not mark any task complete.
  expect((await read(page)).data.actions).toEqual(initial.data.actions)
  await page.locator('[data-recovery-action-id="event-action:old"]').click()
  await expect(page).toHaveURL(/\/library\/job-old$/)
  await expect(page.getByRole('heading', { name: 'Role old', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.locator('[data-action-id="manual"]')).toBeVisible()
  expect((await read(page)).data.actions).toEqual(initial.data.actions)
  await page.locator('[data-action-id="event-action:today"]').getByRole('button', { name: 'View process', exact: true }).click()
  await expect(page).toHaveURL(/\/library\/job-today$/)
  await expect(page.getByRole('heading', { name: 'Role today', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/today$/)
  const manual = page.locator('[data-action-id="manual"]')
  await expect(manual).toBeVisible()
  await manual.getByRole('button', { name: 'Start', exact: true }).click()
  try {
    await expect.poll(async () => (await read(page)).data.actions.find(item => item.id === 'manual')?.status).toBe('doing')
    // The desktop ::before checkmark participates in the accessible name.
    // Match the existing completion control, then independently verify its
    // actual text and enabled state so a stuck pending action still fails.
    const done = manual.locator('button.tsui-done-action')
    await expect(done).toHaveText('Done')
    await expect(done).toHaveAccessibleName(/Done/)
    await expect(done).toBeEnabled()
    console.log(`TODAY_RECOVERY_DONE_ACCESSIBLE_${minutes}:${JSON.stringify(await done.ariaSnapshot())}`)
    await done.click()
    await expect.poll(async () => (await read(page)).data.actions.find(item => item.id === 'manual')?.status).toBe('done')
  } catch (error) {
    const diagnostic = await page.evaluate(async () => {
      let storage: unknown
      try {
        const snapshot = await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()
        storage = { action: snapshot.data.actions.find(item => item.id === 'manual'),
          changeSets: snapshot.data.changeSets?.map(item => ({ id: item.id, status: item.status, error: item.error })) }
      } catch (readError) { storage = { error: String(readError) } }
      const card = document.querySelector('[data-action-id="manual"]')
      return { url: location.href, now: new Date().toISOString(), language: localStorage.getItem('pjsdas-ui-language'),
        cardHtml: card?.outerHTML ?? null, storage,
        buttons: [...(card?.querySelectorAll('button') ?? [])].map(button => ({ text: button.textContent,
          disabled: button.disabled, before: getComputedStyle(button, '::before').content })),
        visibleActionIds: [...document.querySelectorAll('[data-action-id]')].map(item => item.getAttribute('data-action-id')),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent) }
    }).catch(readError => ({ diagnosticError: String(readError) }))
    const accessible = await manual.ariaSnapshot({ timeout: 1000 }).catch(readError => `Unavailable: ${String(readError)}`)
    console.log(`TODAY_RECOVERY_START_DIAGNOSTIC_${minutes}:${JSON.stringify({ ...diagnostic, accessible, pageErrors })}`)
    throw error
  }
  await expect(manual).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-action-id="event-action:today"]')).toHaveCount(1)
  await expect(page.locator('[data-action-id="small"]')).toHaveCount(1)
  await expect(page.locator('[data-recovery-action-id="event-action:old"]')).toHaveCount(1)
  const after = await read(page)
  expect(after.data.actions.find(item => item.id === 'event-action:old')?.status).toBe('todo')
  expect(after.data.processEvents).toEqual(initial.data.processEvents)
  expect(after.data.scheduleNodes).toEqual(initial.data.scheduleNodes)
  await info.attach(`today-recovery-${minutes}-after-user-actions`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
})

for (const minutes of [0, 56]) test(`Chinese Today ${minutes} minutes preserves state while displaying accessible work and recovery`, async ({ page }, info) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.addInitScript(() => localStorage.setItem('pjsdas-ui-language', 'zh'))
  await page.clock.setFixedTime(NOW)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/pjsdas/today')
  await page.locator('.tsui-primary-nav').waitFor()
  await page.evaluate(async value => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(value), fixture(minutes))
  await page.goto('/pjsdas/today')
  await expect(page.locator('[data-action-id]')).toHaveCount(3)
  await expect(page.locator('[data-capacity-limited-action-id]')).toHaveCount(minutes ? 2 : 3)
  await expect(page.locator('[data-recovery-action-id="event-action:old"]')).toBeVisible()
  await expect(page.getByText('过期流程待确认', { exact: true })).toBeVisible()
  await expect(page.locator('[data-action-id="manual"]')).toContainText('当前可用时间不足')
  await expect(page.getByText('现在没有必须处理的任务', { exact: true })).toHaveCount(0)
  const before = await read(page)
  await info.attach(`today-recovery-zh-${minutes}-initial`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  const visual = (await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true })).toString('base64')
  console.log(`TODAY_RECOVERY_ZH_VISUAL_${minutes}_BEGIN`)
  for (let offset = 0; offset < visual.length; offset += 3000) console.log(`TODAY_RECOVERY_ZH_VISUAL_${minutes}_DATA:${visual.slice(offset, offset + 3000)}`)
  console.log(`TODAY_RECOVERY_ZH_VISUAL_${minutes}_END`)
  expect((await read(page)).data).toEqual(before.data)
  await page.reload()
  await expect(page.locator('[data-action-id]')).toHaveCount(3)
  await expect(page.locator('[data-recovery-action-id="event-action:old"]')).toBeVisible()
  expect((await read(page)).data).toEqual(before.data)
})
