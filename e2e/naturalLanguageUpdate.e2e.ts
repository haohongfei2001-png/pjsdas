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
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  await page.evaluate(async (items) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 10)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction('opportunities', 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        for (const item of items) transaction.objectStore('opportunities').put(item)
      }
    })
  }, opportunities)
  await page.reload()
}

async function openNaturalLanguageUpdate(page: Page) {
  await page.locator('.surface-nav').getByRole('button', { name: /设置|Settings/ }).click()
  const dataRecovery = page.locator('details.settings-group').filter({ hasText: /数据与恢复|Data & recovery/ })
  if (!await dataRecovery.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await dataRecovery.locator('summary').click()
  }
  await page.getByRole('button', { name: /更新进展 \/ 事项|Update progress \/ task/ }).click()
  await expect(page.getByRole('heading', { name: /把岗位进展和其他事项直接告诉 PJSDAS|Tell PJSDAS about recruiting progress or another task/ })).toBeVisible()
}

async function readMutationState(page: Page) {
  return page.evaluate(async () => {
    return new Promise<{
      opportunities: Array<{ id: string; company: string; role: string; processStage: string }>
      processes: Array<{ id: string; opportunityId?: string; company: string; role: string; stage: string }>
      actions: Array<{ id: string; title: string; opportunityId?: string; status: string }>
      changeSets: Array<{ id: string; status: string; operations: unknown[] }>
    }>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 10)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'processes', 'actions', 'changeSets'], 'readonly')
        const opportunityRequest = transaction.objectStore('opportunities').getAll()
        const processRequest = transaction.objectStore('processes').getAll()
        const actionRequest = transaction.objectStore('actions').getAll()
        const changeSetRequest = transaction.objectStore('changeSets').getAll()
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve({
            opportunities: opportunityRequest.result,
            processes: processRequest.result,
            actions: actionRequest.result,
            changeSets: changeSetRequest.result,
          })
        }
      }
    })
  })
}

test('explicit non-job task goes through ChangeSet, enters Today, and survives reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  await openNaturalLanguageUpdate(page)

  await page.locator('.progress-inbox-textarea').fill('待办：修改论文图表。')
  await page.getByRole('button', { name: '解析并生成 ChangeSet' }).click()
  await expect(page.getByRole('heading', { name: '准备执行 1 项修改' })).toBeVisible()
  await expect(page.locator('.progress-operation-list')).toContainText('修改论文图表')
  await expect(page.locator('.progress-operation-list')).toContainText('普通事项')

  await page.getByRole('button', { name: '确认并应用 ChangeSet · 1 项' }).click()
  await expect(page.locator('.progress-message.success')).toContainText('已应用 1 项修改')
  await page.getByRole('button', { name: '关闭' }).click()
  await page.locator('.surface-nav').getByRole('button', { name: /今天|Today/ }).click()

  await expect(page.getByRole('heading', { name: '修改论文图表' })).toBeVisible()
  const state = await readMutationState(page)
  const manual = state.actions.filter((item) => item.title === '修改论文图表')
  expect(manual).toHaveLength(1)
  expect(manual[0]).toMatchObject({ status: 'todo' })
  expect(manual[0]!.opportunityId).toBeUndefined()
  expect(state.changeSets.filter((item) => item.status === 'applied')).toHaveLength(1)

  await page.reload()
  await expect(page.getByRole('heading', { name: '修改论文图表' })).toBeVisible()
})

test('editing parsed text invalidates the old ChangeSet and only applies the re-parsed input', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  await openNaturalLanguageUpdate(page)

  const input = page.locator('.progress-inbox-textarea')
  await input.fill('待办：旧任务。')
  await page.getByRole('button', { name: '解析并生成 ChangeSet' }).click()
  await expect(page.getByRole('heading', { name: '准备执行 1 项修改' })).toBeVisible()
  await expect(page.locator('.progress-operation-list')).toContainText('旧任务')

  await input.fill('待办：新任务。')
  await expect(page.getByRole('heading', { name: '准备执行 1 项修改' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认并应用 ChangeSet · 1 项' })).toHaveCount(0)
  await expect(page.locator('.progress-message.success')).toContainText('旧预览已失效')

  await page.getByRole('button', { name: '解析并生成 ChangeSet' }).click()
  await expect(page.getByRole('heading', { name: '准备执行 1 项修改' })).toBeVisible()
  await expect(page.locator('.progress-operation-list')).toContainText('新任务')
  await expect(page.locator('.progress-operation-list')).not.toContainText('旧任务')

  await page.getByRole('button', { name: '确认并应用 ChangeSet · 1 项' }).click()
  await expect(page.locator('.progress-message.success')).toContainText('已应用 1 项修改')
  await page.getByRole('button', { name: '关闭' }).click()

  const state = await readMutationState(page)
  expect(state.actions.filter((item) => item.title === '旧任务')).toHaveLength(0)
  expect(state.actions.filter((item) => item.title === '新任务')).toHaveLength(1)
  expect(state.changeSets.filter((item) => item.status === 'discarded')).toHaveLength(1)
  expect(state.changeSets.filter((item) => item.status === 'applied')).toHaveLength(1)
})

test('source-backed alias application updates the canonical job in place instead of creating a duplicate', async ({ page }) => {
  const canonical = sourceBackedOpportunity('alias-ai-pm', '别名科技', 'AI产品经理（数据平台）')
  await seedOpportunities(page, [canonical])
  await openNaturalLanguageUpdate(page)

  await page.locator('.progress-inbox-textarea').fill('投递 别名科技 AI产品经理。')
  await page.getByRole('button', { name: '解析并生成 ChangeSet' }).click()
  await expect(page.getByRole('heading', { name: '准备执行 1 项修改' })).toBeVisible()
  await expect(page.locator('.progress-operation-list')).toContainText('AI产品经理（数据平台）')

  await page.getByRole('button', { name: '确认并应用 ChangeSet · 1 项' }).click()
  await expect(page.locator('.progress-message.success')).toContainText('已应用 1 项修改')
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

  await page.getByRole('button', { name: /机会/ }).click()
  await page.locator('.surface-context-tabs button').filter({ hasText: '在途流程' }).click()
  await expect(page.getByRole('heading', { name: '在途招聘流程' })).toBeVisible()
  await expect(page.getByText('别名科技')).toBeVisible()
  await expect(page.getByText('AI产品经理（数据平台）')).toBeVisible()

  await page.reload()
  const afterReload = await readMutationState(page)
  expect(afterReload.opportunities).toHaveLength(1)
  expect(afterReload.opportunities[0]!.id).toBe(canonical.id)
})

test('ambiguous same-company role input fails closed without creating a ChangeSet or mutating jobs', async ({ page }) => {
  const jobs = [
    sourceBackedOpportunity('ambiguous-growth', '歧义科技', '产品经理-增长'),
    sourceBackedOpportunity('ambiguous-commercial', '歧义科技', '产品经理-商业化'),
  ]
  await seedOpportunities(page, jobs)
  await openNaturalLanguageUpdate(page)

  await page.locator('.progress-inbox-textarea').fill('投递 歧义科技产品经理。')
  await page.getByRole('button', { name: '解析并生成 ChangeSet' }).click()

  await expect(page.getByRole('heading', { name: '准备执行 0 项修改' })).toBeVisible()
  await expect(page.locator('.progress-plan')).toContainText('1 条待确认')
  await expect(page.locator('.progress-plan')).toContainText('产品经理-增长')
  await expect(page.locator('.progress-plan')).toContainText('产品经理-商业化')
  await expect(page.getByRole('button', { name: '无需应用' })).toBeDisabled()

  const state = await readMutationState(page)
  expect(state.opportunities.map((item) => item.id).sort()).toEqual(jobs.map((item) => item.id).sort())
  expect(state.opportunities.map((item) => item.role).sort()).toEqual(jobs.map((item) => item.role).sort())
  expect(state.processes).toHaveLength(0)
  expect(state.actions).toHaveLength(0)
  expect(state.changeSets).toHaveLength(0)
})
