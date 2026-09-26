import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
const base = process.env.TA_BRAND_BASE ?? '/pjsdas/'
async function visual(page: Page, label: string) {
  await mkdir('test-results/todayaction', { recursive: true })
  await page.screenshot({ path: 'test-results/todayaction/' + label + '.png', fullPage: true, animations: 'disabled' })
  const encoded = (await page.screenshot({ type: 'jpeg', quality: 65, animations: 'disabled' })).toString('base64')
  console.log('TA_VISUAL_' + label + '_BEGIN')
  for (let i = 0; i < encoded.length; i += 3000) console.log('TA_VISUAL_' + label + '_DATA:' + encoded.slice(i, i + 3000))
  console.log('TA_VISUAL_' + label + '_END')
}
test('TodayAction initial HTML, icons and stable installation identity work on deep links', async ({ page, request }) => {
  const html = await request.get(base + 'library/private-test-id')
  expect(html.ok()).toBeTruthy()
  expect(await html.text()).toContain('<title>TodayAction</title>')
  const manifestResponse = await request.get(base + 'manifest.webmanifest')
  expect(manifestResponse.headers()['content-type']).toMatch(/json|manifest/)
  const manifest = await manifestResponse.json()
  expect(manifest.name).toBe('TodayAction')
  expect(manifest.short_name).toBe('TodayAction')
  expect(manifest.id).toBe('/')
  expect(new URL(manifest.start_url, manifestResponse.url()).pathname).toBe(base + 'today')
  for (const icon of [...manifest.icons, { src: 'brand/apple-touch-icon.png', sizes: '180x180' }]) {
    const response = await request.get(new URL(icon.src, manifestResponse.url()).href)
    expect(response.ok()).toBeTruthy()
    expect(response.headers()['content-type']).toMatch(/^image\/png/)
    const bytes = await response.body()
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(bytes.readUInt32BE(16) + 'x' + bytes.readUInt32BE(20)).toBe(icon.sizes)
    const decoded = await page.evaluate(async ({ url }) => {
      const image = new Image(); image.src = url; await image.decode()
      return [image.naturalWidth, image.naturalHeight]
    }, { url: response.url() })
    expect(decoded.join('x')).toBe(icon.sizes)
  }
  const svg = await request.get(base + 'brand/favicon.svg?v=ta-a-1')
  expect(svg.headers()['content-type']).toContain('image/svg+xml')
  expect((await svg.text()).match(/<path /g)).toHaveLength(3)
  const ico = await request.get(base + 'brand/favicon.ico?v=ta-a-1')
  expect(ico.headers()['content-type']).toMatch(/^image\//)
  const bytes = await ico.body()
  expect(bytes.readUInt16LE(2)).toBe(1)
  expect(bytes.readUInt16LE(4)).toBe(3)
  expect([bytes[6], bytes[22], bytes[38]]).toEqual([16, 32, 48])
  await page.goto(base + 'library/private-test-id')
  await expect(page).toHaveTitle('岗位库 · TodayAction')
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute('href', base + 'brand/favicon.svg?v=ta-a-1')
  await expect(page.locator('.tsui-brand')).toHaveAccessibleName('TodayAction，今天')
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(x => x.length))).toBe(0)
})
test('Brand name, accessible capture, language and narrow header preserve the TSUI surface', async ({ page }) => {
  await page.route('**/supabase.co/**', route => route.abort())
  await page.goto(base + 'today')
  await expect(page.locator('.tsui-brand')).toContainText('TodayAction')
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('button')).toHaveCount(3)
  await expect(page).toHaveTitle('今天 · TodayAction')
  await page.setViewportSize({ width: 1440, height: 900 })
  await visual(page, (base === '/' ? 'ROOT' : 'LEGACY') + '_DESKTOP')
  await page.locator('.tsui-topbar').getByRole('button', { name: /告诉 TodayAction/ }).click()
  const dialog = page.getByRole('dialog', { name: '告诉 TodayAction' })
  await expect(dialog.getByRole('textbox', { name: '要告诉 TodayAction 的内容' })).toBeFocused()
  await expect(page).toHaveTitle('记录进展 · TodayAction')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await expect(page.locator('.tsui-brand')).toBeInViewport()
    await expect(page.locator('.tsui-tell-button')).toBeInViewport()
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '' })
  await page.setViewportSize({ width: 390, height: 844 })
  await visual(page, (base === '/' ? 'ROOT' : 'LEGACY') + '_MOBILE')
  await page.goto(base + 'settings')
  await expect(page).toHaveTitle('设置 · TodayAction')
  await expect(page.locator('body')).not.toContainText('PJSDAS')
  await page.evaluate(() => localStorage.setItem('pjsdas-ui-language', 'en'))
  await page.reload()
  await expect(page).toHaveTitle('Settings · TodayAction')
  await page.goto(base + 'schedule')
  await expect(page).toHaveTitle('Schedule · TodayAction')
  await page.goto(base + '?authorization_id=synthetic-brand-check')
  await expect(page.getByRole('heading', { name: '授权 ChatGPT 访问 TodayAction' })).toBeVisible()
  await expect(page).toHaveTitle('ChatGPT 授权 · TodayAction')
  await expect(page.locator('body')).not.toContainText('PJSDAS')
})

test('A mark remains legible at real favicon sizes and maskable crops', async ({ page }) => {
  await page.goto(base + 'today')
  await page.setViewportSize({ width: 1000, height: 700 })
  const origin = new URL(page.url()).origin
  await page.setContent('<html><body style="margin:0;padding:32px;font:16px system-ui;background:#f5f6f9;color:#1b2540"><h1>TodayAction · A asset review</h1><main id="review"></main></body></html>')
  await page.evaluate(({ prefix }) => {
    const review = document.getElementById('review')!
    for (const background of ['#ffffff', '#202632']) {
      const row = document.createElement('section')
      row.style.cssText = 'display:flex;align-items:center;gap:36px;padding:28px;margin-bottom:20px;background:' + background + ';color:' + (background === '#ffffff' ? '#1b2540' : '#fff')
      for (const size of [16, 24, 32, 48]) {
        const item = document.createElement('div')
        const image = new Image(size, size); image.src = prefix + 'brand/favicon-' + size + '.png'
        item.append(image, document.createTextNode(' ' + size + 'px'))
        row.append(item)
      }
      review.append(row)
    }
    const row = document.createElement('section')
    row.style.cssText = 'display:flex;gap:28px;padding:20px;background:#ffffff'
    for (const radius of ['50%', '22%', '0']) {
      const image = new Image(160, 160)
      image.src = prefix + 'brand/icon-maskable-512.png'
      image.style.borderRadius = radius
      row.append(image)
    }
    review.append(row)
  }, { prefix: origin + base })
  await page.locator('img').evaluateAll(async images => {
    await Promise.all(images.map(image => (image as HTMLImageElement).decode()))
  })
  await visual(page, (base === '/' ? 'ROOT' : 'LEGACY') + '_ICONS')
})
