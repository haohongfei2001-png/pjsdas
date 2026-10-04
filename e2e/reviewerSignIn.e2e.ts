import { expect, test, type Page } from '@playwright/test'

const id = '00000000-0000-4000-8000-000000000081'
const email = `ta-consumer-review-a-${id}@example.invalid`
const entry = '/pjsdas/?reviewer_login=1'
const authKey = 'sb-yyrzwpoxlxpafdlbkdtg-auth-token'
const user = { id, email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, identities: [], created_at: '2026-10-04T00:00:00Z' }
function session(identity = user) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return { access_token: `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ sub: identity.id, exp: Math.floor(Date.now() / 1000) + 3600, aud: 'authenticated' })}.synthetic-signature`, refresh_token: 'synthetic-refresh', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user: identity }
}
async function fixture(page: Page, options: { hold?: Promise<void>; fail?: boolean } = {}) {
  const tokenPosts: unknown[] = [], otherWrites: string[] = []
  await page.route('**/*', route => {
    if (route.request().method() === 'POST') otherWrites.push(new URL(route.request().url()).pathname)
    return ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort()
  })
  await page.route('**/auth/v1/token?grant_type=password', async route => {
    if (route.request().method() === 'POST') { tokenPosts.push(route.request().postDataJSON()); await options.hold }
    await route.fulfill({ status: options.fail ? 400 : 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(options.fail ? { code: 'invalid_credentials', msg: 'Do not echo sensitive provider details' } : session()) })
  })
  return { tokenPosts, otherWrites }
}

for (const width of [1280, 390]) test(`reviewer signs in with existing provider, no automatic consent or data access at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); const f = await fixture(page)
  await page.goto(entry)
  await expect(page.getByRole('button', { name: '登录演示账号', exact: true })).toBeVisible()
  await info.attach(`reviewer-signin-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByLabel('演示账号', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill('fixture-only-password')
  await page.getByRole('button', { name: '登录演示账号', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('演示账号已登录。')
  expect(f.tokenPosts).toEqual([{ email, password: 'fixture-only-password', gotrue_meta_security: {} }])
  expect(f.otherWrites).toEqual([])
  await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0)
  expect(page.url()).not.toContain('password')
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('fixture-only-password')
  await page.reload(); await expect(page.getByRole('status')).toHaveText('演示账号已登录。')
  expect(f.tokenPosts).toHaveLength(1); expect(f.otherWrites).toEqual([])
})

test('real identities are not accepted as reviewer fixtures and provider errors stay generic', async ({ page }) => {
  const f = await fixture(page, { fail: true }); await page.goto(entry)
  await page.getByLabel('演示账号', { exact: true }).fill('personal@example.com')
  await page.getByLabel('密码', { exact: true }).fill('fixture-only-password')
  await page.getByRole('button', { name: '登录演示账号', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('不要输入个人账号'); expect(f.tokenPosts).toEqual([])
  await page.getByLabel('演示账号', { exact: true }).fill(email)
  await page.getByRole('button', { name: '登录演示账号', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('登录未完成')
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')
  await expect(page.locator('body')).not.toContainText('Do not echo sensitive provider details')
  expect(f.otherWrites).toEqual([])
})

test('repeated submits create one authentication request and leaving does not approve OAuth', async ({ page }) => {
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(page, { hold }); await page.goto(entry)
  await page.getByLabel('演示账号', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill('fixture-only-password')
  await page.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await expect.poll(() => f.tokenPosts.length).toBe(1)
  await expect(page.getByRole('button', { name: '正在登录…' })).toBeDisabled()
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')
  await page.goto('about:blank'); release(); expect(f.otherWrites).toEqual([])
})

test('existing personal session is preserved and no reviewer login replaces it', async ({ page }) => {
  const f = await fixture(page)
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: authKey, value: session({ ...user, email: 'personal@example.com' }) })
  await page.goto(entry)
  await expect(page.getByRole('status')).toContainText('当前浏览器已有其他账号登录')
  await expect(page.locator('form')).toHaveCount(0)
  expect(f.tokenPosts).toEqual([]); expect(f.otherWrites).toEqual([])
})
