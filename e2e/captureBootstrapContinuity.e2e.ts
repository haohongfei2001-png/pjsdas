import { expect, test } from '@playwright/test'
import { BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'
import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'

for (const gesture of ['pressed', 'editing'] as const) test(`capture survives bootstrap while ${gesture}`, async ({ page }) => {
  await seedSession(page.context())
  const snapshot = workspace()
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  let reads = 0, commands = 0
  await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/**`, route => route.abort())
  await page.route(BACKEND + '/**', async route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test' })
    if (url.pathname === '/api/workspace') {
      const body = request.postDataJSON()
      if (body.action === 'read') {
        reads++; await waiting
        return cors(route, { workspaceId: 'ws-a', revision: 91, workspaceVersion: 'txn:91', schemaVersion: snapshot.version, snapshot })
      }
      if (body.action === 'command') commands++
    }
    return cors(route, { code: 'NOT_FOUND' }, 404)
  })
  await page.goto('/pjsdas/today')
  await expect(page.getByText('正在确认最新状态…', { exact: true })).toBeVisible()
  await expect.poll(() => reads).toBeGreaterThan(0)
  const button = page.locator('.tsui-tell-button')
  const original = await button.elementHandle()
  expect(original).not.toBeNull()
  const input = page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' })
  const response = page.waitForResponse(r => r.url().startsWith(BACKEND + '/api/workspace') && r.request().postDataJSON()?.action === 'read')
  if (gesture === 'pressed') {
    const box = await button.boundingBox(); expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    // Compare the same held state: the existing global :active style translates
    // every button by 1px. That intentional press feedback is not bootstrap movement.
    await expect(button).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 1)')
    const pressedBox = await button.boundingBox(); expect(pressedBox).not.toBeNull()
    release(); await response
    // Observe the installed cloud snapshot, not just receipt of HTTP bytes.
    await expect.poll(() => page.evaluate(async () => {
      const { exportLocalSnapshot } = await import('/pjsdas/src/db.ts')
      return (await exportLocalSnapshot()).data.opportunities.some(item => item.id === 'A-opp-1')
    })).toBe(true)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.getByText('正在确认最新状态…', { exact: true })).toBeVisible()
    expect(await original!.evaluate(node => node.isConnected && node === document.querySelector('.tsui-tell-button'))).toBe(true)
    expect(await button.boundingBox()).toEqual(pressedBox)
    await page.mouse.up()
    await expect(input).toBeFocused()
  } else {
    await button.click(); await expect(input).toBeFocused()
    await input.fill('启动同步期间保留的草稿')
    release(); await response
    await expect(page.getByRole('region', { name: '今天的任务' })).toBeVisible()
    await expect(input).toHaveValue('启动同步期间保留的草稿')
    await expect(input).toBeFocused()
  }
  await expect(page.getByRole('region', { name: '今天的任务' })).toBeVisible()
  expect(await original!.evaluate(node => node.isConnected && node === document.querySelector('.tsui-tell-button'))).toBe(true)
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  expect(commands).toBe(0)
})
