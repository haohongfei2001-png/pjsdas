import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

async function emitVisual(page: Page, label: string) {
  const bytes = await page.screenshot({ type: 'jpeg', quality: 52, animations: 'disabled' })
  const encoded = bytes.toString('base64')
  console.log(`TSUI03_VISUAL_${label}_BEGIN`)
  for (let offset = 0; offset < encoded.length; offset += 3000) console.log(`TSUI03_VISUAL_${label}_DATA:${encoded.slice(offset, offset + 3000)}`)
  console.log(`TSUI03_VISUAL_${label}_END`)
}

test('TSUI-03 300-job paging, exact posting identity, routed detail and truthful application link', async ({ page, context }) => {
  await page.goto('./')
  await expect(page.locator('.tsui-primary-nav')).toBeVisible()
  await page.evaluate(async () => {
    const createdAt = new Date('2026-09-20T00:00:00.000Z').toISOString()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['opportunities', 'actions'], 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        for (let index = 0; index < 300; index += 1) tx.objectStore('opportunities').put({
          id: 'tsui03-bulk-' + index,
          company: '批量岗位 ' + index,
          role: 'Product researcher / 产品研究员 ' + index,
          currentStageLabel: '待投递', processStage: 'not_applied',
          roleType: 'core', participationStatus: 'active', early: false,
          opportunityValue: 70, fitScore: 70, importedAt: createdAt,
        })
        for (const suffix of ['a', 'b']) tx.objectStore('actions').put({
          id: 'tsui03-apply-' + suffix, kind: 'apply', title: '提交同名科技申请',
          opportunityId: 'tsui03-posting-' + suffix, processStage: 'not_applied',
          estimatedMinutes: 20, leverage: 85, delayCost: 85,
          status: 'todo', createdAt, updatedAt: createdAt,
        })
        for (const suffix of ['a', 'b']) tx.objectStore('opportunities').put({
          id: 'tsui03-posting-' + suffix,
          company: '同名科技', role: 'Senior Product / 高级产品设计与研究',
          currentStageLabel: '待投递', processStage: 'not_applied',
          roleType: 'core', participationStatus: 'active', early: false, locallyManaged: true,
          opportunityValue: 80, fitScore: 80, importedAt: createdAt,
          detail: { userFacts: { applicationUrl: 'https://apply.example.test/posting/' + suffix } },
        })
      }
    })
  })
  await page.reload()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /岗位库|Jobs/ }).click()
  await expect(page.locator('.tsui-job-row')).toHaveCount(40)
  await expect(page.locator('.tsui-library-more')).toContainText('40/302')
  await mkdir('test-results/tsui03', { recursive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  console.log('TSUI03_ENV:' + JSON.stringify(await page.evaluate(() => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, rootFontPx: getComputedStyle(document.documentElement).fontSize, viewport: [innerWidth, innerHeight] }))))
  await page.screenshot({ path: 'test-results/tsui03/library-desktop.png', fullPage: true, animations: 'disabled' })
  await emitVisual(page, 'LIBRARY_DESKTOP')
  const identityGap = await page.locator('.tsui-job-open').first().evaluate((row) => {
    const mark = row.querySelector('.tsui-job-mark')!.getBoundingClientRect()
    const identity = row.querySelector('.tsui-job-identity')!.getBoundingClientRect()
    return identity.left - mark.right
  })
  console.log('TSUI03_IDENTITY_GAP:' + identityGap)
  expect(identityGap).toBeGreaterThanOrEqual(8)
  expect(identityGap).toBeLessThanOrEqual(22)
  while (await page.locator('.tsui-library-more').count()) await page.locator('.tsui-library-more').click()
  const ids = await page.locator('.tsui-job-row').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-opportunity-id')))
  expect(ids).toHaveLength(302)
  expect(new Set(ids).size).toBe(302)

  const search = page.getByRole('searchbox', { name: /搜索公司或岗位|Search company or role/ })
  await search.fill('同名科技')
  const rows = page.locator('.tsui-job-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('data-opportunity-id', /tsui03-posting-[ab]/)
  await expect(rows.nth(1)).toHaveAttribute('data-opportunity-id', /tsui03-posting-[ab]/)
  // The row itself carries the exact opportunity ID; never infer it from company and role.
  const a = page.locator('.tsui-job-row[data-opportunity-id="tsui03-posting-a"]')
  const b = page.locator('.tsui-job-row[data-opportunity-id="tsui03-posting-b"]')
  await expect(a.locator('.tsui-job-apply')).toHaveAttribute('href', 'https://apply.example.test/posting/a')
  await expect(b.locator('.tsui-job-apply')).toHaveAttribute('href', 'https://apply.example.test/posting/b')
  await context.route('https://apply.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Application destination</title>' }))
  const popupPromise = page.waitForEvent('popup')
  await a.locator('.tsui-job-apply').click()
  const popup = await popupPromise
  await expect(popup).toHaveURL('https://apply.example.test/posting/a')
  await popup.close()
  const stage = await page.evaluate(async () => new Promise<string | undefined>((resolve, reject) => {
    const request = indexedDB.open('pjsdas', 11)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('opportunities', 'readonly')
      const get = tx.objectStore('opportunities').get('tsui03-posting-a')
      get.onerror = () => reject(get.error)
      get.onsuccess = () => { db.close(); resolve(get.result?.processStage) }
    }
  }))
  expect(stage).toBe('not_applied')
  const actionStatus = await page.evaluate(async () => new Promise<string | undefined>((resolve, reject) => {
    const request = indexedDB.open('pjsdas', 11)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('actions', 'readonly')
      const get = tx.objectStore('actions').get('tsui03-apply-a')
      get.onerror = () => reject(get.error)
      get.onsuccess = () => { db.close(); resolve(get.result?.status) }
    }
  }))
  expect(actionStatus).toBe('todo')

  await a.locator('.tsui-job-open').click()
  await expect(page).toHaveURL(/\/library\/tsui03-posting-a$/)
  const detail = page.locator('.job-detail-page')
  await expect(detail.getByRole('heading', { name: 'Senior Product / 高级产品设计与研究' })).toBeVisible()
  await expect(detail.locator('.job-detail-actions a')).toHaveAttribute('href', 'https://apply.example.test/posting/a')
  await expect(detail.getByRole('button', { name: /我已投递|I applied/ })).toBeVisible()
  await page.screenshot({ path: 'test-results/tsui03/detail-desktop.png', fullPage: true, animations: 'disabled' })
  await emitVisual(page, 'DETAIL_DESKTOP')
  const detailStyle = await detail.locator('.job-detail-surface').evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    shadow: getComputedStyle(element).boxShadow,
  }))
  console.log('TSUI03_DETAIL_STYLE:' + JSON.stringify(detailStyle))
  expect(detailStyle.shadow).toBe('none')
  await expect(detail.locator('.job-detail-related')).toContainText(/相关记录|Related records/)
  await page.locator('.job-detail-back').click()
  await expect(search).toHaveValue('同名科技')
  await expect(a.locator('.tsui-job-open')).toBeFocused()
  await b.locator('.tsui-job-open').click()
  await expect(page).toHaveURL(/\/library\/tsui03-posting-b$/)
  await expect(page.locator('.job-detail-actions a')).toHaveAttribute('href', 'https://apply.example.test/posting/b')
  await page.goBack()
  await expect(b.locator('.tsui-job-open')).toBeFocused()

  await search.fill('')
  await expect(rows).toHaveCount(40)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/tsui03/library-mobile.png', fullPage: true, animations: 'disabled' })
  await emitVisual(page, 'LIBRARY_MOBILE')
  await a.locator('.tsui-job-open').click()
  await page.screenshot({ path: 'test-results/tsui03/detail-mobile.png', fullPage: true, animations: 'disabled' })
  await emitVisual(page, 'DETAIL_MOBILE')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  await page.locator('.job-detail-back').click()
  await page.setViewportSize({ width: 320, height: 640 })
  const normalFont = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const enlargedFont = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))
  console.log('TSUI03_LARGE_TEXT_FONT:' + JSON.stringify({ normalFont, enlargedFont }))
  expect(enlargedFont / normalFont).toBeGreaterThan(1.9)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  await a.locator('.tsui-job-open').click()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: 'test-results/tsui03/detail-large-text-320.png', fullPage: true, animations: 'disabled' })
})

test('TSUI-03 Today and Schedule detail links restore their exact opener and old deep links remain readable', async ({ page }) => {
  await page.goto('./')
  await page.evaluate(async () => {
    const now = Date.now()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['opportunities', 'actions'], 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.objectStore('opportunities').put({
          id: 'tsui03-context-opp', company: '上下文公司', role: 'Researcher',
          currentStageLabel: '待投递', processStage: 'not_applied',
          deadline: new Date(now + 2 * 86400000).toISOString().slice(0, 10), deadlinePrecision: 'date',
          roleType: 'core', participationStatus: 'active', early: false, locallyManaged: true,
          opportunityValue: 80, fitScore: 80, importedAt: new Date(now - 86400000).toISOString(),
        })
        tx.objectStore('actions').put({
          id: 'tsui03-context-action', kind: 'manual', title: '准备上下文申请',
          opportunityId: 'tsui03-context-opp',
          estimatedMinutes: 20, leverage: 90, delayCost: 90,
          status: 'todo', createdAt: new Date(now - 86400000).toISOString(), updatedAt: new Date(now - 86400000).toISOString(),
        })

      }
    })
  })
  await page.reload()
  const task = page.locator('.tsui-task-row[data-action-id="tsui03-context-action"]')
  await expect(task).toBeVisible()
  await task.locator('.tsui-task-context').click()
  await expect(page).toHaveURL(/\/library\/tsui03-context-opp$/)
  await expect(page.locator('.job-detail-back')).toContainText(/返回今天|Back to Today/)
  await page.locator('.job-detail-back').click()
  await expect(page).toHaveURL(/\/today$|\/pjsdas\/$|\/$/)
  await expect(task.locator('.tsui-task-context')).toBeFocused()

  await page.locator('.tsui-primary-nav').getByRole('button', { name: /日程|Schedule/ }).click()
  const node = page.locator('.tsui-schedule-panel .tsui-schedule-row').filter({ hasText: '上下文公司' })
  await expect(node).toHaveCount(1)
  await expect(node).toBeVisible()
  await node.click()
  await expect(page.locator('.tsui-schedule-detail')).toContainText('上下文公司')
  await page.locator('.tsui-schedule-detail .tsui-schedule-job-link').click()
  await expect(page).toHaveURL(/\/library\/tsui03-context-opp$/)
  await expect(page.locator('.job-detail-back')).toContainText(/返回日程|Back to Schedule/)
  await page.locator('.job-detail-back').click()
  await expect(page).toHaveURL(/\/schedule$/)
  await expect(node).toBeVisible()

  await page.goto('/pjsdas/opportunities/tsui03-context-opp')
  await expect(page.locator('.job-detail-page')).toContainText('上下文公司')
})
