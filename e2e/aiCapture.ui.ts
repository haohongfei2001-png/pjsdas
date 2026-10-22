import { expect, test, type Page } from '@playwright/test'
import { BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'
import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'
async function setup(page: Page, mode: 'ready' | 'question' | 'failure' = 'ready', delayed = false) {
  await seedSession(page.context())
  const snapshot = workspace(), previews: any[] = [], commands: any[] = []
  let release: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { release = resolve })
  await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/**`, route => route.abort())
  await page.route(BACKEND + '/**', async route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test' })
    if (url.pathname === '/api/workspace') {
      const body = request.postDataJSON()
      if (url.searchParams.get('surface') === 'ai-capture-preview') {
        previews.push(body)
        if (delayed) await waiting
        if (mode === 'failure') return cors(route, { code: 'AI_CAPTURE_NOT_ENABLED', message: 'AI unavailable; nothing saved.' }, 503)
        return cors(route, { requestId: body.requestId, workspaceRevision: 91, referenceTime: '2026-10-19T00:00:00Z', canCommit: mode === 'ready',
          review: { status: mode === 'ready' ? 'ready_for_review' : 'no_write', statementMode: mode === 'ready' ? 'current_intent' : 'question',
            candidates: [{ id: 'ai-capture:1', kind: 'manual_action', title: '模型理解的合成任务', plannedDate: '2026-10-20', objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }],
            issues: mode === 'question' ? [{ message: '你希望记录这个任务，还是只询问建议？' }] : [] } })
      }
      if (body.action === 'read') return cors(route, { workspaceId: 'ws-a', revision: 91, workspaceVersion: 'txn:91', schemaVersion: snapshot.version, snapshot })
      if (body.action === 'command') { commands.push(body); return cors(route, { outcome: 'CONFLICT', revision: 91, workspaceVersion: 'txn:91', schemaVersion: snapshot.version,
        conflict: { kind: 'AI_CAPTURE_STALE', message: 'Synthetic conflict: nothing written.', objects: [] } }, 409) }
      return cors(route, { code: 'NOT_FOUND' }, 404)
    }
    return cors(route, { code: 'NOT_FOUND' }, 404)
  })
  await page.goto('/pjsdas/today')
  await page.locator('.tsui-tell-button').click()
  const input = page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' })
  await expect(input).toBeFocused()
  return { input, previews, commands, release: () => release!(), organize: page.getByRole('button', { name: '整理输入内容并预览' }) }
}
test('typing does not call a model; explicit preview saves only its durable ID', async ({ page }) => {
  const f = await setup(page)
  await f.input.fill('等天亮了提醒我把那件搁置的小事办了')
  await page.waitForTimeout(400); expect(f.previews).toHaveLength(0)
  await f.organize.click(); await expect(page.locator('.cgr-understanding')).toContainText('模型理解的合成任务')
  expect(f.previews).toHaveLength(1)
  await expect(page.locator('.cgr-understanding')).toContainText('2026-10-20')
  await expect(page.locator('.cgr-understanding')).toContainText('Asia/Shanghai')
  await page.getByRole('button', { name: '确认并保存', exact: true }).click()
  await expect.poll(() => f.commands.length).toBe(1)
  expect(f.commands[0].command).toEqual({ type: 'ai_capture_confirm', value: { requestId: f.previews[0].requestId } })
  expect(f.commands[0].baseRevision).toBe(91)
  expect(f.commands[0]).not.toHaveProperty('captureOriginalText')
})
test('edits invalidate late preview and do not auto-request another paid interpretation', async ({ page }) => {
  const f = await setup(page, 'ready', true)
  await f.input.fill('原始合成内容'); await f.organize.click()
  await expect.poll(() => f.previews.length).toBe(1)
  await f.input.fill('新的合成内容'); f.release()
  await page.waitForTimeout(500)
  await expect(page.locator('.cgr-understanding')).not.toContainText('模型理解的合成任务')
  expect(f.previews).toHaveLength(1); expect(f.commands).toHaveLength(0)
  await f.input.press('Control+Enter'); expect(f.commands).toHaveLength(0)
})
test('question clarification cannot be promoted into a write', async ({ page }) => {
  const f = await setup(page, 'question')
  await f.input.fill('你觉得我应该做什么？'); await f.organize.click()
  await expect(page.locator('.cgr-understanding')).toContainText('你希望记录这个任务，还是只询问建议？')
  await expect(page.getByRole('button', { name: '确认并保存', exact: true })).toBeDisabled()
  expect(f.commands).toHaveLength(0)
})
test('model failure is visible and has no local-parser fallback', async ({ page }) => {
  const f = await setup(page, 'failure')
  await f.input.fill('明天买咖啡'); await f.organize.click()
  await expect(page.locator('.cgr-capture-sheet')).toContainText('AI 理解暂时不可用')
  await expect(page.getByRole('alert')).toContainText('没有保存任何内容')
  await expect(page.locator('.cgr-understanding')).not.toContainText('买咖啡')
  expect(f.commands).toHaveLength(0); expect(f.previews).toHaveLength(1)
  await f.organize.click()
  await expect.poll(() => f.previews.length).toBe(2)
  expect(f.previews[1].requestId).toBe(f.previews[0].requestId)
})

test('closing an in-flight preview preserves its retry identity without auto-requesting on reopen', async ({ page }) => {
  const f = await setup(page, 'ready', true)
  await f.input.fill('关闭后继续核对的合成内容')
  await f.organize.click()
  await expect.poll(() => f.previews.length).toBe(1)
  await f.input.press('Escape')
  f.release()
  await page.locator('.tsui-tell-button').click()
  await expect(f.input).toHaveValue('关闭后继续核对的合成内容')
  await page.waitForTimeout(300)
  expect(f.previews).toHaveLength(1)
  await expect(page.locator('.cgr-understanding')).not.toContainText('模型理解的合成任务')
  await f.organize.click()
  await expect.poll(() => f.previews.length).toBe(2)
  expect(f.previews[1].requestId).toBe(f.previews[0].requestId)
  expect(f.commands).toHaveLength(0)
})

test('closing before the preview debounce never starts interpretation on reopen', async ({ page }) => {
  const f = await setup(page)
  await f.input.fill('还未发出的合成内容')
  // One task closes before the 180ms debounce; no timing race with the driver.
  await f.organize.evaluate(button => {
    (button as HTMLButtonElement).click()
    document.querySelector<HTMLButtonElement>('.tsui-tell-button')!.click()
  })
  await expect(page.locator('.tsui-tell-button')).toHaveAttribute('aria-expanded', 'false')
  await page.waitForTimeout(250)
  expect(f.previews).toHaveLength(0)
  await page.locator('.tsui-tell-button').click()
  await page.waitForTimeout(250)
  expect(f.previews).toHaveLength(0)
  await f.organize.click()
  await expect.poll(() => f.previews.length).toBe(1)
  expect(f.commands).toHaveLength(0)
})

for (const secondaryMode of ['manual', 'review'] as const) {
  test(`${secondaryMode} round-trip retains unknown preview identity but requires another explicit click`, async ({ page }) => {
    const f = await setup(page, 'failure')
    await f.input.fill('保留原始请求的合成内容')
    await f.organize.click()
    await expect(page.locator('.cgr-capture-sheet')).toContainText('AI 理解暂时不可用')
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    if (secondaryMode === 'manual') {
      await page.getByRole('button', { name: '手动填写岗位', exact: true }).click()
      await page.getByRole('button', { name: '用自然语言添加', exact: true }).click()
    } else {
      await page.getByRole('button', { name: '核实已有记录', exact: true }).click()
      await page.getByRole('button', { name: '返回记录进展', exact: true }).click()
    }
    await expect(f.input).toHaveValue('保留原始请求的合成内容')
    await page.waitForTimeout(250)
    expect(f.previews).toHaveLength(1)
    await f.organize.click()
    await expect.poll(() => f.previews.length).toBe(2)
    expect(f.previews[1].requestId).toBe(f.previews[0].requestId)
    expect(f.commands).toHaveLength(0)
  })
}
