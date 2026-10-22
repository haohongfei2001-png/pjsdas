import { expect, test } from '@playwright/test'
import { BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'
import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'

for (const recovery of ['explicit', 'background'] as const) test(`legacy AI ${recovery} receipt never consumes an unowned global draft`, async ({ page }) => {
  const accountKey = 'legacy-ai-owner', text = '保留这条相同文字的新草稿', commandId = 'legacy-ai-command'
  await seedSession(page.context(), accountKey, 'synthetic-token')
  const snapshot = workspace()
  let release = () => {}, commands = 0, previews = 0, receipts = 0
  const held = new Promise<void>(resolve => { release = resolve })
  page.on('close', release)
  await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/**`, route => route.abort())
  await page.route(BACKEND + '/**', async route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname === '/api/access') return cors(route, { authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test' })
    if (url.pathname === '/api/workspace') {
      const body = request.postDataJSON()
      const base = { workspaceId: 'synthetic-legacy', revision: 91, workspaceVersion: 'txn:91', schemaVersion: snapshot.version, snapshot }
      if (url.searchParams.get('surface') === 'ai-capture-preview') { previews++; return cors(route, { code: 'UNEXPECTED_MODEL_REQUEST' }, 409) }
      if (body.action === 'read') return cors(route, base)
      if (body.action === 'command') { commands++; return cors(route, { code: 'UNEXPECTED_EFFECT' }, 409) }
      if (body.action === 'receipt') {
        receipts++; await held
        return cors(route, { ...base, found: true, receipt: { commandId, status: 'COMMITTED', result: { status: 'APPLIED', summary: 'Original operation reconciled' } } })
      }
    }
    return cors(route, { code: 'NOT_FOUND' }, 404)
  })
  try {
    await page.goto('/pjsdas/today')
    await expect(page.getByRole('region', { name: '今天的任务' })).toBeVisible()
    expect(await page.evaluate(async () => (await import('/pjsdas/src/aiCaptureClient.ts')).aiCaptureEnabled())).toBe(true)
    await page.evaluate(async ({ accountKey, text, commandId, recovery }) => {
      const api = await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')
      await api.queueConnectedBusinessCommand(accountKey, { type: 'ai_capture_confirm', value: { requestId: 'legacy-preview' } }, { commandId })
      // A pre-context version of the persisted outbox: no captureContextRefs.
      const key = `pjsdas-cgr01-pending:${encodeURIComponent(accountKey)}`
      const rows = JSON.parse(localStorage.getItem(key)!)
      rows[0].captureOriginalText = text
      rows[0].status = recovery === 'explicit' ? 'unknown' : 'pending'
      delete rows[0].captureContextRefs
      localStorage.setItem(key, JSON.stringify(rows))
      api.saveAccountDraft(accountKey, 'tell-pjsdas', text)
    }, { accountKey, text, commandId, recovery })
    await page.locator('.tsui-tell-button').click()
    const input = page.getByLabel('要告诉 TodayAction 的内容', { exact: true })
    await expect(input).toHaveValue(text)
    if (recovery === 'explicit') await page.getByRole('button', { name: '确认保存状态', exact: true }).click()
    else await page.evaluate(account => { void import('/pjsdas/src/cloud/authoritativeCommandClient.ts').then(api => api.replayAccountPendingOperations(account)) }, accountKey)
    await expect.poll(() => receipts).toBeGreaterThan(0)
    release()
    await expect(page.locator('.cgr-capture-receipt')).toContainText('当前岗位的输入没有提交')
    await expect(input).toHaveValue(text)
    await expect(page.locator('.cgr-understanding-head span')).toHaveText('尚未保存')
    await expect(page.locator('.cgr-understanding-head span')).not.toHaveAttribute('data-state', 'saved')
    expect(await page.evaluate(async account => (await import('/pjsdas/src/cloud/authoritativeCommandClient.ts')).readAccountDraft(account, 'tell-pjsdas'), accountKey)).toBe(text)
    expect(commands).toBe(0); expect(previews).toBe(0)
  } finally { release() }
})
