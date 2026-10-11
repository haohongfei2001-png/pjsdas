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
  const recoveryTitle = page.getByRole('region', { name: '过期流程待确认', exact: true }).locator('strong')
  await expect(recoveryTitle).toHaveText('过期流程待确认 · 1')
  await expect(recoveryTitle).toBeVisible()
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

test('all 500 dense Today tasks remain accessible, searchable, printable and keyboard-operable', async ({ page, browserName }, info) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.addInitScript(() => localStorage.setItem('pjsdas-ui-language', 'en'))
  await page.clock.setFixedTime(NOW)
  await page.setViewportSize({ width: 1280, height: 720 })
  const lastTitle = 'Dense task 499: Review portfolio and supporting examples 核对作品集与面试材料，保留完整标题和全部操作'
  const snapshot = createSnapshot({ opportunities: [], processes: [], processEvents: [], prep: [], applicationGroups: [],
    actions: Array.from({ length: 500 }, (_, index) => ({
      ...action(`dense-${String(index).padStart(3, '0')}`, index === 499 ? lastTitle : `Dense task ${index}`, undefined, 0, '2026-10-11'),
      estimatedMinutes: 20,
    })), timePlanning: { version: 1, dateOverrides: { '2026-10-11': 0 }, updatedAt: NOW.toISOString() },
  }, NOW.toISOString())
  await page.goto('/pjsdas/today')
  await page.locator('.tsui-primary-nav').waitFor()
  await page.evaluate(async value => (await import('/pjsdas/src/db.ts')).replaceLocalSnapshotFromCloud(value), snapshot)
  await page.goto('/pjsdas/today')
  await expect(page.locator('[data-action-id]')).toHaveCount(500)
  await expect(page.locator('[data-capacity-limited-action-id]')).toHaveCount(500)
  await expect(page.locator('.tsui-task-list')).toHaveClass(/is-dense/)
  const before = await read(page)
  const last = page.locator('[data-action-id="dense-499"]')
  const start = last.getByRole('button', { name: 'Start', exact: true })
  const done = last.locator('button.tsui-done-action')
  await expect(page.getByRole('heading', { level: 3 })).toHaveCount(500)
  await expect(last.getByRole('heading', { name: lastTitle, exact: true })).toHaveCount(1)
  await expect(start).toHaveAccessibleName('Start')
  await expect(done).toHaveAccessibleName(/Done/)
  const accessible = await last.ariaSnapshot()
  expect(accessible).toContain(lastTitle)
  expect(accessible).toContain('Start')
  expect(accessible).toContain('Done')
  await info.attach('dense-last-task-accessibility.txt', { body: accessible, contentType: 'text/plain' })
  const findResult = await page.evaluate(title => {
    window.scrollTo(0, 0)
    const find = (window as Window & { find?: (text: string) => boolean }).find
    return { supported: typeof find === 'function', found: find?.call(window, title), selection: getSelection()?.toString() }
  }, lastTitle)
  if (browserName === 'firefox' && process.env.TODAY_FIND_DIAGNOSTIC === '1') {
    const observations: unknown[] = [{ mode: 'auto', phase: 'immediate', ...findResult }]
    const observe = async (mode: string, phase: string) => {
      const observation = await last.evaluate((card, label) => {
        const selection = getSelection(), textBeforeLayout = selection?.toString()
        const rect = card.getBoundingClientRect()
        const neighbors: unknown[] = []
        let previous = card.previousElementSibling
        for (let index = 0; previous && index < 3; index++, previous = previous.previousElementSibling) {
          const box = previous.getBoundingClientRect()
          neighbors.push({ id: previous.getAttribute('data-action-id'), inViewport: box.bottom > 0 && box.top < innerHeight,
            rendered: previous.checkVisibility({ contentVisibilityAuto: true }), title: previous.querySelector('h3')?.textContent })
        }
        return { ...label, textBeforeLayout, textAfterLayout: selection?.toString(), rangeCount: selection?.rangeCount,
          anchor: selection?.anchorNode?.parentElement?.outerHTML, scrollY,
          inViewport: rect.bottom > 0 && rect.top < innerHeight,
          contentVisibility: getComputedStyle(card).contentVisibility, neighbors }
      }, { mode, phase })
      observations.push(observation)
    }
    const settle = async (mode: string) => {
      let viewportMatched = true
      await expect(last).toBeInViewport({ timeout: 1000 }).catch(() => { viewportMatched = false })
      observations.push({ mode, phase: 'viewport', matched: viewportMatched })
      await observe(mode, 'after-viewport')
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
      await observe(mode, 'next-frame')
      let pollMatched = true
      await expect.poll(() => page.evaluate(() => getSelection()?.toString()), { timeout: 1000 }).toBe(lastTitle)
        .catch(() => { pollMatched = false })
      observations.push({ mode, phase: 'poll', matched: pollMatched })
      await observe(mode, 'after-poll')
    }
    await settle('auto')
    await info.attach('firefox-find-auto', { body: await page.screenshot(), contentType: 'image/png' })
    const override = await page.addStyleTag({ content: '.tsui-task-list.is-dense>.tsui-task-row[data-action-id]{content-visibility:visible!important;contain:none!important;contain-intrinsic-block-size:none!important}' })
    try {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
      const plain = await page.evaluate(title => {
        getSelection()?.removeAllRanges(); window.scrollTo(0, 0)
        const find = (window as Window & { find?: (text: string) => boolean }).find
        return { found: find?.call(window, title), selection: getSelection()?.toString() }
      }, lastTitle)
      observations.push({ mode: 'forced-visible', phase: 'immediate', ...plain })
      await settle('forced-visible')
      await info.attach('firefox-find-forced-visible', { body: await page.screenshot(), contentType: 'image/png' })
    } finally { await override.evaluate(style => style.remove()) }
    expect((await read(page)).data).toEqual(before.data)
    console.log(`TODAY_FIND_DIAGNOSTIC:${JSON.stringify(observations)}`)
    await info.attach('firefox-find-observations.json', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })
  }
  expect(findResult.supported).toBe(true)
  expect(findResult.found).toBe(true)
  expect(findResult.selection).toBe(lastTitle)
  await expect(last).toBeInViewport()
  await page.evaluate(() => { getSelection()?.removeAllRanges(); window.scrollTo(0, 0) })
  // Native focus must reveal the off-screen row; Tab retains the existing order.
  await start.focus()
  await expect(start).toBeFocused()
  await expect(start).toBeInViewport()
  await page.keyboard.press('Tab')
  await expect(done).toBeFocused()
  await expect(done).toBeInViewport()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  expect(await last.evaluate(card => card.matches(':focus-within'))).toBe(false)
  await page.emulateMedia({ media: 'print' })
  expect(await page.locator('[data-action-id]').evaluateAll(cards => cards.every(card => {
    const style = getComputedStyle(card)
    return style.contentVisibility === 'visible' && style.contain === 'none'
  }))).toBe(true)
  await expect(page.locator('[data-action-id]')).toHaveCount(500)
  await page.emulateMedia({ media: 'screen' })
  await page.setViewportSize({ width: 390, height: 844 })
  await last.scrollIntoViewIfNeeded()
  const bounds = await last.evaluate(card => {
    const rect = card.getBoundingClientRect(), heading = card.querySelector('h3')!
    const title = heading.getBoundingClientRect()
    return { pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      focused: card.matches(':focus-within'), contentVisibility: getComputedStyle(card).contentVisibility,
      supportsAuto: CSS.supports('content-visibility', 'auto') && CSS.supports('contain-intrinsic-block-size', 'auto 120px'),
      titleFits: heading.scrollHeight <= heading.clientHeight + 1 && title.left >= rect.left - 1
        && title.right <= rect.right + 1 && title.top >= rect.top - 1 && title.bottom <= rect.bottom + 1,
      controlsInside: [...card.querySelectorAll('button')].every(button => {
        const box = button.getBoundingClientRect()
        return box.left >= rect.left - 1 && box.right <= rect.right + 1 && box.bottom <= rect.bottom + 1
      }) }
  })
  expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.viewportWidth)
  expect(bounds.focused).toBe(false)
  if (bounds.supportsAuto) expect(bounds.contentVisibility).toBe('auto')
  expect(bounds.titleFits).toBe(true)
  expect(bounds.controlsInside).toBe(true)
  expect((await read(page)).data).toEqual(before.data)
  await start.click()
  await expect.poll(async () => (await read(page)).data.actions.find(item => item.id === 'dense-499')?.status).toBe('doing')
  await expect(done).toHaveText('Done')
  await expect(done).toBeEnabled()
  await done.click()
  await expect.poll(async () => (await read(page)).data.actions.find(item => item.id === 'dense-499')?.status).toBe('done')
  await expect(page.locator('[data-action-id]')).toHaveCount(499)
  expect((await read(page)).data.actions.filter(item => item.id !== 'dense-499')).toEqual(before.data.actions.filter(item => item.id !== 'dense-499'))
  console.log(`TODAY_DENSE_ACCESSIBILITY:${JSON.stringify({ tasks: 500, findResult, bounds, userCompleted: 'dense-499' })}`)
})
