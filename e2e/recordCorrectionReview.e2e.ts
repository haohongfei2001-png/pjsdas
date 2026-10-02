import { applySemanticIntake } from '../src/semanticIntake.js'
import { expect, test, type Page } from '@playwright/test'
import { setupInstantServer } from './fixtures/instantServer.js'
import { BACKEND } from './fixtures/todayWorkspace.js'
import { INSTANT_NOW } from '../tests/fixtures/instantDenseWorkspace.js'
import { applicationDeadlineFingerprint } from '../src/applicationDeadline.js'

test.use({ timezoneId: 'Asia/Shanghai' })
function packet(server: Awaited<ReturnType<typeof setupInstantServer>>) {
  const target = server.snapshot.data.opportunities.find(item => item.id === 'dense-job-2')!
  return { schema: 'todayaction-correction-review-v1', accountId: 'instant-owner', reviewedAt: INSTANT_NOW.toISOString(), workspaceVersion: 'txn:1204', excluded: [{ opportunityId: 'dense-job-3', reason: 'Synthetic submitted exclusion.' }], held: [],
    entries: [{ company: target.company, role: target.role, reviewStatus: 'ready', command: { commandId: 'synthetic-review-browser-command', kind: 'correct_application_deadline', opportunityId: target.id, expectedDeadlineFingerprint: applicationDeadlineFingerprint(target, server.snapshot.data), correction: { state: 'unknown', sourceUrl: 'https://careers.example.test/verified-role', sourceAuthority: 'university_repost', evidence: 'Synthetic verified source does not publish a deadline; availability is unknown.', checkedAt: INSTANT_NOW.toISOString(), postingStatus: 'unknown' } } }],
  }
}
async function open(page: Page) {
  await page.goto('/pjsdas/today/capture')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['instant-owner']?.lastSyncedVersion)).toBe('txn:1204')
  await page.getByRole('button', { name: '核实已有记录', exact: true }).click()
  await expect(page.locator('.cgr-correction-review')).toBeVisible()
}
async function upload(page: Page, value: unknown) {
  await page.locator('.cgr-correction-review input[type=file]').setInputFiles({ name: 'synthetic-review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) })
}
async function review(page: Page) {
  await page.locator('.cgr-correction-entries button').click()
  await expect(page.locator('.cgr-correction-review input[type=checkbox]')).toBeVisible()
  await page.locator('.cgr-correction-review input[type=checkbox]').check()
}

test('authenticated correction reviews evidence, commits once, retains history and clears file on reload', async ({ page, context }, info) => {
  const server = await setupInstantServer(context, 100); server.setDelay(0)
  await page.clock.setFixedTime(INSTANT_NOW); await open(page); await upload(page, packet(server)); await review(page)
  await expect(page.locator('.cgr-correction-review')).toContainText('无可靠截止日期（不代表仍开放）')
  await expect(page.locator('.cgr-correction-review')).toContainText('university_repost')
  await page.screenshot({ path: info.outputPath('correction-review.png'), fullPage: true })
  await page.getByRole('button', { name: '确认修正这一条', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
  await expect(page.locator('.cgr-correction-review')).toContainText('服务器已确认')
  expect(server.sent).toEqual(['synthetic-review-browser-command'])
  const target = server.snapshot.data.opportunities.find(item => item.id === 'dense-job-2')!
  expect(target.deadline).toBeUndefined(); expect(target.detail?.deadlineCorrections).toHaveLength(1)
  expect(server.snapshot.data.scheduleNodes?.some(node => node.opportunityId === target.id && node.state === 'superseded')).toBe(true)
  await page.reload(); await page.getByRole('button', { name: '核实已有记录', exact: true }).click()
  await expect(page.locator('.cgr-correction-entries')).toHaveCount(0)
  await expect(page.locator('.cgr-correction-review')).toContainText('不提供普通撤销')
})

test('changed owner after review refuses without a command or token substitution', async ({ page, context }) => {
  const server = await setupInstantServer(context, 100); server.setDelay(0)
  await page.clock.setFixedTime(INSTANT_NOW); await open(page); const input = packet(server); await upload(page, input); await review(page)
  server.snapshot.data.scheduleNodes!.find(item => item.opportunityId === 'dense-job-2')!.temporal.deadlineAt = '2026-10-12T00:00:00Z'
  await page.getByRole('button', { name: '确认修正这一条', exact: true }).click()
  await expect(page.locator('.cgr-correction-review [role=alert]')).toContainText('changed')
  expect(server.sent).toEqual([])
  await expect(page.getByRole('button', { name: '确认修正这一条', exact: true })).toBeDisabled()
})

test('malformed whole packet and excluded target are never partially imported', async ({ page, context }) => {
  const server = await setupInstantServer(context, 100)
  await page.clock.setFixedTime(INSTANT_NOW); await open(page)
  const input = packet(server); input.excluded.push({ opportunityId: 'dense-job-2', reason: 'External applied evidence.' })
  await upload(page, input); await expect(page.locator('.cgr-correction-review [role=alert]')).toBeVisible()
  await expect(page.locator('.cgr-correction-entries')).toHaveCount(0)
  const malformed = packet(server); (malformed.entries as unknown[]).push({ company: 'Partial' })
  await upload(page, malformed); await expect(page.locator('.cgr-correction-entries')).toHaveCount(0)
  expect(server.sent).toEqual([])
})

test('receipt recovery after accepted response loss never creates a second correction', async ({ page, context }) => {
  const server = await setupInstantServer(context, 100); server.setDelay(0); server.loseNextResponse()
  await page.clock.setFixedTime(INSTANT_NOW); await open(page); await upload(page, packet(server)); await review(page)
  await page.getByRole('button', { name: '确认修正这一条', exact: true }).click()
  await expect(page.locator('.cgr-correction-review')).toContainText('服务器已确认')
  await page.getByRole('button', { name: '核对原操作回执', exact: true }).click()
  await expect(page.locator('.cgr-correction-review')).toContainText('本次没有重发')
  expect(server.snapshot.data.opportunities.find(item => item.id === 'dense-job-2')!.detail?.deadlineCorrections).toHaveLength(1)
  expect(new Set(server.sent)).toEqual(new Set(['synthetic-review-browser-command']))
})

test('closing a pending review clears private file and ignores late reads', async ({ page, context }) => {
  const server = await setupInstantServer(context, 100)
  await page.clock.setFixedTime(INSTANT_NOW); await open(page); await upload(page, packet(server))
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  await context.route(`${BACKEND}/api/workspace`, async route => { const body = route.request().postDataJSON(); if (body?.action === 'read') { entered(); await blocked } await route.fallback() })
  await page.locator('.cgr-correction-entries button').click(); await started
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  release()
  await page.locator('.tsui-topbar').getByRole('button', { name: /告诉 TodayAction/ }).click()
  await page.getByRole('button', { name: '核实已有记录', exact: true }).click()
  await expect(page.locator('.cgr-correction-entries')).toHaveCount(0)
  expect(server.sent).toEqual([])
})

test('signed-out review entry cannot import or apply a local correction', async ({ page }) => {
  await page.goto('/pjsdas/today/capture'); await page.getByRole('button', { name: '核实已有记录', exact: true }).click()
  await expect(page.locator('.cgr-correction-review input[type=file]')).toBeDisabled()
  await expect(page.locator('.cgr-correction-review')).toContainText('不会修改本地模式的数据')
})

test('an intervening account lease change prevents submission and close clears its review', async ({ page, context }) => {
  const server = await setupInstantServer(context, 100)
  await page.clock.setFixedTime(INSTANT_NOW); await open(page); await upload(page, packet(server)); await review(page)
  await page.evaluate(async () => (await import('/pjsdas/src/cloud/accountCacheLease.ts')).setAccountCacheSession('different-owner'))
  await page.getByRole('button', { name: '确认修正这一条', exact: true }).click()
  await expect(page.locator('.cgr-correction-review [role=alert]')).toBeVisible()
  expect(server.sent).toEqual([])
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(async () => (await import('/pjsdas/src/cloud/accountCacheLease.ts')).setAccountCacheSession('instant-owner'))
  await page.locator('.tsui-topbar').getByRole('button', { name: /告诉 TodayAction/ }).click()
  await page.getByRole('button', { name: '核实已有记录', exact: true }).click()
  await expect(page.locator('.cgr-correction-entries')).toHaveCount(0)
})

test('review mode never submits hidden natural-language capture through keyboard shortcut', async ({ page, context }) => {
  const server = await setupInstantServer(context, 100)
  await page.clock.setFixedTime(INSTANT_NOW); await open(page)
  await page.getByRole('button', { name: '返回记录进展', exact: true }).click()
  await page.getByRole('textbox', { name: '要告诉 TodayAction 的内容', exact: true }).fill('新增行动：核对合成岗位')
  await page.getByRole('button', { name: '核实已有记录', exact: true }).click()
  await page.keyboard.press('Control+Enter')
  await expect(page.locator('.cgr-correction-review input[type=file]')).toBeVisible()
  expect(server.sent).toEqual([])
})


test('terminal evidence correction retains the original event and displays its exact receipt', async ({ page, context }) => {
  const server = await setupInstantServer(context, 100); server.setDelay(0)
  const seeded = applySemanticIntake(server.snapshot, { contractVersion: 1, inputId: 'synthetic-browser-false-offer', source: { kind: 'gmail', sourceId: 'gmail:synthetic', sourceRecordId: 'synthetic-false-offer', observedAt: INSTANT_NOW.toISOString(), timezone: 'Asia/Shanghai' }, statementMode: 'assertion', candidates: [{ id: 'false-offer', kind: 'process_event', eventType: 'offer', target: { opportunityId: 'dense-job-4' }, occurredAt: INSTANT_NOW.toISOString(), objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: ['synthetic:misread-procedure'], sourceVersionRefs: ['synthetic:v1'] }] }, { authorized: true, now: INSTANT_NOW })
  Object.assign(server.snapshot, seeded.snapshot)
  const event = server.snapshot.data.processEvents[0], target = server.snapshot.data.opportunities.find(item => item.id === event.opportunityId)!
  const input: any = packet(server)
  input.entries = [{ company: target.company, role: target.role, reviewStatus: 'ready', command: { commandId: 'synthetic-browser-invalidation', kind: 'invalidate_process_event', opportunityId: target.id, eventId: event.id, receiptId: seeded.receipt!.id, expectedEventUpdatedAt: event.updatedAt, reason: 'The synthetic source described a procedure, not a personal offer.', evidenceRefs: ['synthetic:verified-procedure'] } }]
  await page.clock.setFixedTime(INSTANT_NOW); await open(page); await upload(page, input); await review(page)
  await expect(page.locator('.cgr-correction-review')).toContainText(seeded.receipt!.id)
  await page.getByRole('button', { name: '确认修正这一条', exact: true }).click()
  await expect(page.locator('.cgr-correction-review')).toContainText('服务器已确认')
  expect(server.snapshot.data.processEvents.find(item => item.id === event.id)?.invalidation).toBeTruthy()
  expect(server.snapshot.data.opportunities.find(item => item.id === target.id)?.processStage).toBe('unknown')
})
