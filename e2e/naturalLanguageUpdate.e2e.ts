import { expect, test, type Page } from '@playwright/test'
import { createJobPostingEvidence } from '../src/jobPosting.js'

function sourceBackedOpportunity(id: string, company: string, role: string) {
  const observedAt = '2026-09-10T00:00:00.000Z'
  const sourceUrl = `https://careers.e2e.example/jobs/${id}`
  return {
    id,
    company,
    role,
    currentStageLabel: '待投递',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 86,
    fitScore: 80,
    locallyManaged: true,
    importedAt: observedAt,
    detail: {
      discovery: {
        sourceUrl,
        sourceTitle: role,
        rationale: 'browser E2E canonical source',
        discoveredAt: observedAt,
        fitConfidence: 'high',
        opportunityValueConfidence: 'high',
        posting: createJobPostingEvidence({
          company,
          role,
          sourceUrl,
          sourceTitle: role,
          observedAt,
        }),
      },
    },
  }
}

async function seedOpportunities(page: Page, opportunities: ReturnType<typeof sourceBackedOpportunity>[]) {
  await page.goto('/')
  await page.evaluate(async (items) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction('opportunities', 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => { db.close(); resolve() }
        for (const item of items) transaction.objectStore('opportunities').put(item)
      }
    })
  }, opportunities)
  await page.reload()
}

async function openCapture(page: Page) {
  await page.locator('.ultimate-capture-button').click()
  await expect(page.getByRole('heading', { name: '告诉 PJSDAS' })).toBeVisible()
}

async function readMutationState(page: Page) {
  return page.evaluate(async () => new Promise<{
    opportunities: Array<{ id: string; company: string; role: string; processStage: string }>
    processes: Array<{ id: string; opportunityId?: string; company: string; role: string; stage: string }>
    processEvents: Array<{ id: string; eventType: string }>
    actions: Array<{ id: string; title: string; opportunityId?: string; status: string }>
    decisionRequests: Array<{ id: string; state: string; question: string }>
    semanticReceipts: Array<{ id: string; status: string }>
    changeSets: Array<{ id: string; status: string; operations: unknown[] }>
  }>((resolve, reject) => {
    const request = indexedDB.open('pjsdas', 11)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['opportunities', 'processes', 'processEvents', 'actions', 'decisionRequests', 'semanticReceipts', 'changeSets'], 'readonly')
      const opportunities = tx.objectStore('opportunities').getAll()
      const processes = tx.objectStore('processes').getAll()
      const processEvents = tx.objectStore('processEvents').getAll()
      const actions = tx.objectStore('actions').getAll()
      const decisions = tx.objectStore('decisionRequests').getAll()
      const receipts = tx.objectStore('semanticReceipts').getAll()
      const changeSets = tx.objectStore('changeSets').getAll()
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => {
        db.close()
        resolve({
          opportunities: opportunities.result,
          processes: processes.result,
          processEvents: processEvents.result,
          actions: actions.result,
          decisionRequests: decisions.result,
          semanticReceipts: receipts.result,
          changeSets: changeSets.result,
        })
      }
    }
  }))
}

test('explicit non-job task enters Today through Semantic Intake without ChangeSet maintenance', async ({ page }) => {
  await page.goto('/')
  await openCapture(page)

  await page.locator('.cgr-capture-input').fill('待办：修改论文图表。')
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByRole('status')).toContainText('已记录明确事实')
  await page.getByRole('button', { name: '关闭' }).click()

  await expect(page.getByRole('heading', { name: '修改论文图表' })).toBeVisible()
  const state = await readMutationState(page)
  expect(state.actions.filter((item) => item.title === '修改论文图表')).toHaveLength(1)
  expect(state.changeSets).toHaveLength(0)
  expect(state.semanticReceipts.some((item) => item.status === 'committed')).toBe(true)

  await page.reload()
  await expect(page.getByRole('heading', { name: '修改论文图表' })).toBeVisible()
})

test('a quoted old thread cannot create a second action beside the current Web update', async ({ page }) => {
  await page.goto('/')
  await openCapture(page)
  await page.locator('.cgr-capture-input').fill('待办：修改论文图表。\n-----Original Message-----\n待办：整理旧材料。')
  await expect(page.locator('.cgr-understanding-body')).toContainText('引用的旧消息')
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByRole('status')).toContainText('已记录明确事实')
  await expect(page.getByRole('status')).toContainText('未作为当前事实处理')
  await page.getByRole('button', { name: '关闭' }).click()
  const state = await readMutationState(page)
  expect(state.actions.map((item) => item.title)).toEqual(['修改论文图表'])
  expect(state.changeSets).toHaveLength(0)
})

test('narrow and enlarged-text capture exposes mixed current/quoted feedback without horizontal clipping', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.evaluate(() => { document.documentElement.style.fontSize = '20px' })
  await page.locator('.ultimate-mobile-capture').click()
  const dialog = page.getByRole('dialog', { name: '告诉 PJSDAS' })
  await dialog.getByRole('textbox', { name: '要告诉 PJSDAS 的内容' })
    .fill('待办：修改论文图表。\n-----Original Message-----\n待办：整理旧材料。')
  await expect(dialog.locator('.cgr-understanding-body')).toContainText('引用的旧消息')
  await expect(dialog.getByRole('button', { name: '确认并保存' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2)
  await testInfo.attach('cgr04-narrow-mixed-intake', { body: await page.screenshot(), contentType: 'image/png' })
  await dialog.getByRole('button', { name: '确认并保存' }).click()
  await expect(dialog.getByRole('status')).toContainText('未作为当前事实处理')
})

test('questions and rewrite requests remain read-only', async ({ page }) => {
  await page.goto('/')
  await openCapture(page)

  await page.locator('.cgr-capture-input').fill('这个岗位我该不该投？')
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByRole('status')).toContainText('没有被当作当前事实写入')
  await page.getByRole('button', { name: '关闭' }).click()

  const state = await readMutationState(page)
  expect(state.actions).toHaveLength(0)
  expect(state.processes).toHaveLength(0)
  expect(state.changeSets).toHaveLength(0)
})

test('source-backed alias application updates the canonical job in place instead of creating a duplicate', async ({ page }) => {
  const canonical = sourceBackedOpportunity('alias-ai-pm', '别名科技', 'AI产品经理（数据平台）')
  await seedOpportunities(page, [canonical])
  await openCapture(page)

  await page.locator('.cgr-capture-input').fill('投递 别名科技 AI产品经理。')
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByRole('status')).toContainText('已记录明确事实')
  await page.getByRole('button', { name: '关闭' }).click()

  const state = await readMutationState(page)
  expect(state.opportunities).toHaveLength(1)
  expect(state.opportunities[0]).toMatchObject({
    id: canonical.id,
    company: canonical.company,
    role: canonical.role,
    processStage: 'screening',
  })
  expect(state.processes).toHaveLength(1)
  expect(state.processes[0]).toMatchObject({ opportunityId: canonical.id, stage: 'screening' })
  expect(state.changeSets).toHaveLength(0)

  await page.locator('.surface-nav').getByRole('button', { name: /机会/ }).click()
  const row = page.locator('.opportunity-decision-row').filter({ hasText: '别名科技' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('AI产品经理（数据平台）')
})

test('a company name containing 测试 does not turn a submitted application into an assessment invite', async ({ page }) => {
  const canonical = sourceBackedOpportunity('testing-company-ai-pm', '节点测试科技', 'AI产品经理')
  await seedOpportunities(page, [canonical])
  await openCapture(page)

  await page.locator('.cgr-capture-input').fill('节点测试科技 AI产品经理 已投递成功。')
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByRole('status')).toContainText('已记录明确事实')
  await page.getByRole('button', { name: '关闭' }).click()

  const state = await readMutationState(page)
  expect(state.opportunities).toHaveLength(1)
  expect(state.opportunities[0]).toMatchObject({ id: canonical.id, processStage: 'screening' })
  expect(state.processes).toHaveLength(1)
  expect(state.processEvents).toHaveLength(0)
  expect(state.decisionRequests).toHaveLength(0)
})

test('ambiguous same-company role input creates DecisionRequest instead of guessing or exposing ChangeSet', async ({ page }) => {
  const jobs = [
    sourceBackedOpportunity('ambiguous-growth', '歧义科技', '产品经理-增长'),
    sourceBackedOpportunity('ambiguous-commercial', '歧义科技', '产品经理-商业化'),
  ]
  await seedOpportunities(page, jobs)
  await openCapture(page)

  await page.locator('.cgr-capture-input').fill('投递 歧义科技产品经理。')
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByRole('status')).toContainText('1 项需要你决定')
  await page.getByRole('button', { name: '去决定' }).click()

  await expect(page.getByRole('heading', { name: '只处理真正需要你决定的事' })).toBeVisible()
  await expect(page.getByRole('button', { name: /歧义科技｜产品经理-增长/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /歧义科技｜产品经理-商业化/ })).toBeVisible()

  const state = await readMutationState(page)
  expect(state.opportunities.map((item) => item.id).sort()).toEqual(jobs.map((item) => item.id).sort())
  expect(state.processes).toHaveLength(0)
  expect(state.actions).toHaveLength(0)
  expect(state.changeSets).toHaveLength(0)
  expect(state.decisionRequests).toHaveLength(1)
  expect(state.decisionRequests[0]?.state).toBe('open')

  await page.locator('.surface-nav').getByRole('button', { name: /机会/ }).click()
  await page.locator('.opportunity-decision-filter select').selectOption('all')
  await page.locator('.opportunity-decision-row').filter({ hasText: '产品经理-增长' }).click()
  const detail = page.getByRole('dialog', { name: /岗位详情|Opportunity details/ })
  await expect(detail.locator('.opportunity-detail-decisions')).toContainText(state.decisionRequests[0]!.question)
  await detail.getByRole('button', { name: '处理这项决定' }).click()
  await expect(detail).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/decisions/${encodeURIComponent(state.decisionRequests[0]!.id)}\\?from=ambiguous-growth$`))
  await expect(page.getByRole('button', { name: /歧义科技｜产品经理-增长/ })).toBeVisible()
  await page.getByRole('button', { name: /歧义科技｜产品经理-增长/ }).click()
  await expect(page.locator('.ultimate-receipt')).toContainText('决定已处理')
  await page.getByRole('button', { name: '返回刚才的机会' }).click()
  await expect(page.getByRole('dialog', { name: /岗位详情|Opportunity details/ })).toContainText('产品经理-增长')

  const resolved = await readMutationState(page)
  expect(resolved.opportunities).toHaveLength(2)
  expect(resolved.opportunities.find((item) => item.id === 'ambiguous-growth')?.processStage).toBe('screening')
  expect(resolved.opportunities.find((item) => item.id === 'ambiguous-commercial')?.processStage).toBe('not_applied')
  expect(resolved.decisionRequests[0]?.state).toBe('answered')
})
