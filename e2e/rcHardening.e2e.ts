import { expect, test } from '@playwright/test'

test('RC shell keeps primary navigation keyboard-accessible and horizontally stable', async ({ page }) => {
  await page.goto('/')

  const main = page.locator('main.surface-main')
  const nav = page.locator('.surface-nav')
  await expect(main).toBeVisible()
  await expect(nav).toBeVisible()

  const navButtons = nav.getByRole('button')
  await expect(navButtons).toHaveCount(5)

  for (let index = 0; index < 5; index += 1) {
    const button = navButtons.nth(index)
    await expect(button).toBeVisible()
    const accessibleText = await button.evaluate((node) =>
      (node.getAttribute('aria-label') || node.textContent || '').trim(),
    )
    expect(accessibleText.length).toBeGreaterThan(0)
  }

  await navButtons.first().focus()
  await expect(navButtons.first()).toBeFocused()

  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewport + 2)

  await nav.getByRole('button', { name: /设置|Settings/ }).click()
  const dataRecovery = page.locator('details.settings-group > summary').filter({ hasText: /数据与恢复|Data & recovery/ })
  await dataRecovery.focus()
  await expect(dataRecovery).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dataRecovery.locator('..')).toHaveAttribute('open', '')

  await page.getByRole('button', { name: 'EN', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Connections, automation, and durable control' })).toBeVisible()
})

test('RC Attention and Activity remain distinct at narrow viewport', async ({ page }) => {
  await page.goto('/')
  const nav = page.locator('.surface-nav')

  await nav.getByRole('button', { name: /Attention/ }).click()
  await expect(page.getByRole('heading', { name: /这里只放真正需要你决定的事|Only the exceptions that genuinely need you/ })).toBeVisible()

  await nav.getByRole('button', { name: /活动|Activity/ }).click()
  await expect(page.getByRole('heading', { name: /系统和你都做了什么|What you and PJSDAS have done/ })).toBeVisible()
  await expect(page.locator('.activity-page')).toBeVisible()

  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewport + 2)
})
