import { expect, test, type Page, type Route } from '@playwright/test'
const owner = '00000000-0000-4000-8000-000000000001',
  clientId = '00000000-0000-4000-8000-000000000002',
  grantId = '00000000-0000-4000-8000-000000000003'
const authKey = 'sb-yyrzwpoxlxpafdlbkdtg-auth-token'
const entry = '/pjsdas/?manage_access=1'
const view = () => ({
  account: { id: owner, email: 'owner@example.invalid' },
  consent: {
    version: 2,
    capability: 'workspace.manage',
    title: '指定业务数据管理',
    scope: [
      '创建、修改、可恢复归档独立准备任务',
      '创建、修改、可恢复归档独立手动行动',
      '创建、修改、可恢复归档投递组',
      '有冲突时不会覆盖后续修改',
    ],
    exclusions: [
      '不允许永久删除、账号安全设置或外部消息/投递',
      '扩大范围需要重新明确授权',
    ],
    duration: '持续有效直到你撤销；撤销不回滚已经完成的修改。',
  },
  consentTextHash: 'a'.repeat(64),
  clients: [
    {
      id: clientId,
      name: 'Synthetic owner client',
      canApprove: true,
      grant: null as null | {
        id: string
        client_id: string
        revision: number
        revoked_at: string | null
        consent_version: 2
      },
    },
  ],
})
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  })
}
async function fixture(
  page: Page,
  options: {
    unknownFirst?: boolean
    disabled?: boolean
    holdFirstRead?: Promise<void>
    holdPost?: Promise<void>
  } = {},
) {
  const state = view()
  const posts: Record<string, unknown>[] = []
  let readCount = 0,
    writeCount = 0
  const receipts = new Map<string, unknown>()
  await page.addInitScript(
    ({ key, owner }) => {
      if (!localStorage.getItem('owner-consent-seeded')) {
        localStorage.setItem(
          key,
          JSON.stringify({
            access_token: 'synthetic-owner-session',
            refresh_token: 'synthetic-refresh',
            token_type: 'bearer',
            expires_in: 86400,
            expires_at: Math.floor(Date.now() / 1000) + 86400,
            user: {
              id: owner,
              aud: 'authenticated',
              role: 'authenticated',
              email: 'owner@example.invalid',
              app_metadata: { provider: 'google', providers: ['google'] },
              user_metadata: { sub: owner },
              identities: [],
              created_at: '2026-10-01T00:00:00Z',
            },
          }),
        )
        localStorage.setItem('owner-consent-seeded', '1')
      }
    },
    { key: authKey, owner },
  )
  // No request containing even a synthetic bearer may leave this browser fixture.
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return route.abort()
    return route.continue()
  })
  await page.route('**/api/health', (route) =>
    json(route, {
      status: 'ok',
      version: '1.10.0-alpha.1',
      workspaceAuthority: 'transactional',
      mode: 'transactional-connected',
      capabilities: { deploymentPortability: true },
    }),
  )
  await page.route(
    '**/api/workspace?surface=owner-management-consent',
    async (route) => {
      if (route.request().method() === 'OPTIONS') return json(route, {})
      if (options.disabled)
        return json(route, { code: 'CAPABILITY_DISABLED' }, 404)
      if (route.request().method() === 'GET') {
        readCount++
        if (readCount === 1 && options.holdFirstRead)
          await options.holdFirstRead
        return json(route, state)
      }
      const body = route.request().postDataJSON()
      posts.push(body)
      expect(body.expectedAccountId).toBe(owner)
      expect(body.clientId).toBe(clientId)
      expect(body.confirmed).toBe(true)
      if (options.holdPost) await options.holdPost
      if (!receipts.has(body.requestId)) {
        writeCount++
        state.clients[0].grant = {
          id: grantId,
          client_id: clientId,
          revision: writeCount,
          revoked_at:
            body.decision === 'revoke' ? '2026-10-02T00:00:00Z' : null,
          consent_version: 2,
        }
        receipts.set(body.requestId, {
          requestId: body.requestId,
          decision: body.decision,
          refreshRequired: true,
          receipt: {
            outcome: body.decision === 'approve' ? 'APPROVED' : 'REVOKED',
            grant_id: grantId,
            grant_revision: writeCount,
          },
        })
      }
      if (options.unknownFirst && posts.length === 1)
        return json(
          route,
          { code: 'CONSENT_OUTCOME_UNCONFIRMED', requestId: body.requestId },
          503,
        )
      return json(route, receipts.get(body.requestId))
    },
  )
  return {
    state,
    posts,
    get reads() {
      return readCount
    },
    get writes() {
      return writeCount
    },
  }
}
async function selectAndConfirm(page: Page) {
  await page
    .getByRole('combobox', { name: '选择已连接客户端' })
    .selectOption(clientId)
  await page.getByRole('checkbox').check()
}
test('owner consent requires deliberate exact selection; repeated clicks commit once and revoke reads back', async ({
  page,
}) => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(page, { holdPost: hold })
  await page.goto(entry)
  await expect(
    page.getByText('owner@example.invalid', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '授权这个客户端', exact: true }),
  ).toBeDisabled()
  await selectAndConfirm(page)
  await expect(
    page.getByText(`客户端 ID：${clientId}`, { exact: true }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: '授权这个客户端', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
  await expect.poll(() => f.posts.length).toBe(1)
  await expect(
    page.getByRole('button', { name: '授权这个客户端', exact: true }),
  ).toBeDisabled()
  release()
  await expect(
    page.getByText('最近读取的状态：扩展管理已授权', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('checkbox')).not.toBeChecked()
  expect(f.writes).toBe(1)
  await page.getByRole('checkbox').check()
  await page
    .getByRole('button', { name: '撤销扩展管理授权', exact: true })
    .click()
  await expect(
    page.getByText('最近读取的状态：未授权或已撤销', { exact: true }),
  ).toBeVisible()
  expect(f.writes).toBe(2)
})
test('unknown outcome requires readback and exact request retry, never a second approval', async ({
  page,
}) => {
  const f = await fixture(page, { unknownFirst: true })
  await page.goto(entry)
  await selectAndConfirm(page)
  await page
    .getByRole('button', { name: '授权这个客户端', exact: true })
    .click()
  await expect(
    page.getByText(
      '请求结果尚未确认。请先重新读取；不要另建授权请求。关闭页面不会撤销可能已完成的授权。',
    ),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '重试同一请求', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: '重新读取状态', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '重试同一请求', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: '重试同一请求', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '重试同一请求', exact: true }),
  ).toHaveCount(0)
  expect(f.posts).toHaveLength(2)
  expect(f.posts[1]).toEqual(f.posts[0])
  expect(f.writes).toBe(1)
})
test('closing while read is delayed cannot surface a stale consent or issue a grant; Back only reads', async ({
  page,
}) => {
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture(page, { holdFirstRead: hold })
  await page.goto(entry)
  await expect.poll(() => f.reads).toBe(1)
  await page
    .getByRole('button', { name: '返回 TodayAction', exact: true })
    .click()
  release()
  await expect(page).not.toHaveURL(/manage_access/)
  await expect(
    page.getByRole('heading', { name: '选择这个客户端可以管理什么' }),
  ).toHaveCount(0)
  await page.goBack()
  await expect(
    page.getByRole('heading', { name: '选择这个客户端可以管理什么' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '授权这个客户端', exact: true }),
  ).toBeDisabled()
  expect(f.posts).toEqual([])
})
test('default-off owner entry remains readable and cannot approve', async ({
  page,
}) => {
  const f = await fixture(page, { disabled: true })
  await page.goto(entry)
  await expect(
    page.getByText('扩展管理尚未启用。现有 TodayAction 插件核心工具仍可使用。'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '授权这个客户端', exact: true }),
  ).toHaveCount(0)
  expect(f.posts).toEqual([])
})
test('synthetic owner consent layout is readable at desktop and mobile widths', async ({
  page,
}, testInfo) => {
  await fixture(page)
  await page.goto(entry)
  await selectAndConfirm(page)
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height })
    await expect(
      page.getByRole('heading', { name: '权限范围 · v2' }),
    ).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true)
    const path = testInfo.outputPath(`owner-consent-${width}.png`)
    await page.screenshot({ path, fullPage: true })
    await testInfo.attach(`owner-consent-${width}`, {
      path,
      contentType: 'image/png',
    })
  }
})

test('ordinary persisted Back/Forward pageshow clears old consent and freshly reads', async ({
  page,
}) => {
  const f = await fixture(page)
  await page.goto(entry)
  await selectAndConfirm(page)
  const before = f.reads
  f.state.consent.scope.push('新读取的范围提示')
  f.state.consentTextHash = 'b'.repeat(64)
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent('pageshow', { persisted: true }),
    ),
  )
  await expect.poll(() => f.reads).toBeGreaterThan(before)
  await expect(
    page.getByText('新读取的范围提示', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('checkbox')).not.toBeChecked()
  await expect(
    page.getByRole('button', { name: '授权这个客户端', exact: true }),
  ).toBeDisabled()
  expect(f.posts).toEqual([])
})
test('uncertain request survives pre-POST session loss and full page sign-in return', async ({
  page,
}) => {
  const f = await fixture(page, { unknownFirst: true })
  await page.goto(entry)
  await selectAndConfirm(page)
  await page
    .getByRole('button', { name: '授权这个客户端', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: '重试同一请求', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: '重新读取状态', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '重试同一请求', exact: true }),
  ).toBeEnabled()
  const saved = await page.evaluate((key) => {
    const value = localStorage.getItem(key)
    localStorage.removeItem(key)
    return value
  }, authKey)
  await page.getByRole('button', { name: '重试同一请求', exact: true }).click()
  await expect(
    page.getByRole('button', {
      name: '使用 Google 登录 TodayAction',
      exact: true,
    }),
  ).toBeVisible()
  expect(f.posts).toHaveLength(1)
  // Restore only the synthetic fixture session, then recreate the whole document.
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value!), {
    key: authKey,
    value: saved,
  })
  await page.reload()
  await expect(
    page.getByRole('button', { name: '重试同一请求', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: '重试同一请求', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '重试同一请求', exact: true }),
  ).toHaveCount(0)
  expect(f.posts).toHaveLength(2)
  expect(f.posts[1]).toEqual(f.posts[0])
  expect(f.writes).toBe(1)
})
