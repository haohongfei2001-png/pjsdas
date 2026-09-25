import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const NOW = new Date('2026-09-25T04:00:00.000Z')
const CREATED = '2026-09-20T00:00:00.000Z'

async function emitCloudVisual(page: Page, label: string) {
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 50, animations: 'disabled' })
  const encoded = screenshot.toString('base64')
  console.log(`TSUI_VISUAL_${label}_BEGIN`)
  for (let offset = 0; offset < encoded.length; offset += 3000) console.log(`TSUI_VISUAL_${label}_DATA:${encoded.slice(offset, offset + 3000)}`)
  console.log(`TSUI_VISUAL_${label}_END`)
}

test('TSUI-02 real component: equal Today rows, shared 130-node stream and mobile switch', async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  await page.goto('/pjsdas/today')
  await page.evaluate(async ({ created }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['actions', 'scheduleNodes'], 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        for (let i = 0; i < 8; i += 1) tx.objectStore('actions').put({
          id: 'tsui-task-' + i, kind: 'manual', title: '今日行动 ' + (i + 1),
          estimatedMinutes: 20, leverage: 90 - i, delayCost: 80 - i,
          status: 'todo', createdAt: created, updatedAt: created,
        })
        for (let i = 0; i < 130; i += 1) {
          const date = new Date(Date.UTC(2026, 8, 25 + i)).toISOString().slice(0, 10)
          tx.objectStore('scheduleNodes').put({
            id: 'tsui-node-' + i, occurrenceId: 'tsui-occurrence-' + i, version: 1,
            kind: 'interview', state: 'scheduled', constraintKind: 'employer_hard',
            temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai', date, resolutionBasis: 'source_explicit' },
            evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
            createdAt: created, updatedAt: created,
          })
        }
      }
    })
  }, { created: CREATED })
  await page.reload()
  const nav = page.getByRole('navigation', { name: '主导航' })
  await expect(nav.getByRole('button')).toHaveCount(3)
  await expect(page.locator('.tsui-task-row')).toHaveCount(8)
  await expect(page.locator('.cgr-primary-action')).toHaveCount(0)
  const first = await page.locator('.tsui-task-row').first().boundingBox()
  const sixth = await page.locator('.tsui-task-row').nth(5).boundingBox()
  expect(first).not.toBeNull()
  expect(sixth).not.toBeNull()
  expect(Math.abs(first!.height - sixth!.height)).toBeLessThan(2)
  await mkdir('test-results/tsui02', { recursive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: 'test-results/tsui02/today-desktop.png', fullPage: true, animations: 'disabled' })
  await emitCloudVisual(page, 'DESKTOP')
  const geometry = await page.evaluate(() => {
    const main = document.querySelector('.cgr-main')!.getBoundingClientRect()
    const tasks = document.querySelector('.tsui-task-panel')!.getBoundingClientRect()
    const nodes = document.querySelector('.tsui-node-panel')!.getBoundingClientRect()
    return { mainLeft: main.left, taskLeft: tasks.left, taskWidth: tasks.width, nodeWidth: nodes.width, nodeRight: nodes.right }
  })
  console.log('TSUI_GEOMETRY_DESKTOP:' + JSON.stringify(geometry))
  expect(geometry.taskLeft).toBeGreaterThanOrEqual(48)
  expect(geometry.taskLeft).toBeLessThanOrEqual(72)
  expect(geometry.nodeRight).toBeGreaterThanOrEqual(1360)
  expect(geometry.nodeRight).toBeLessThanOrEqual(1392)
  expect(geometry.taskWidth / geometry.nodeWidth).toBeGreaterThan(1.3)
  expect(geometry.taskWidth / geometry.nodeWidth).toBeLessThan(1.5)
  while (await page.locator('.tsui-node-panel .tsui-load-more').count()) {
    await page.locator('.tsui-node-panel .tsui-load-more').click()
  }
  await expect(page.locator('.tsui-node-panel .tsui-node-row')).toHaveCount(130)
  await page.getByRole('button', { name: /日程/ }).first().click()
  await expect(page).toHaveURL(/\/schedule$/)
  await expect(page.locator('.tsui-schedule-panel .tsui-schedule-row').first()).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-task-row')).toHaveCount(8)
  await expect(page.locator('.tsui-node-panel')).toBeHidden()
  await page.screenshot({ path: 'test-results/tsui02/today-mobile.png', fullPage: true, animations: 'disabled' })
  await emitCloudVisual(page, 'MOBILE')
  await page.getByRole('button', { name: /节点 130/ }).click()
  await expect(page.locator('.tsui-node-panel')).toBeVisible()
  await page.screenshot({ path: 'test-results/tsui02/today-mobile-nodes.png', fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: /任务 8/ }).click()
  await page.setViewportSize({ width: 320, height: 640 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: 'test-results/tsui02/today-320-large-text.png', fullPage: true, animations: 'disabled' })
  await emitCloudVisual(page, 'LARGE_TEXT')
})
