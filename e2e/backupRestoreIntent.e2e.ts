import { expect, test, type Page } from '@playwright/test'

const opportunity = {
  id: 'e2e-backup-intent-opportunity',
  company: '备份意图测试科技',
  role: 'AI产品经理',
  currentStageLabel: '待投递',
  processStage: 'not_applied',
  roleType: 'core',
  early: false,
  opportunityValue: 84,
  fitScore: 82,
  locallyManaged: true,
  importedAt: '2026-09-14T00:00:00.000Z',
}

const action = {
  id: 'e2e-backup-intent-action',
  kind: 'apply',
  title: '提交备份意图测试科技 AI 产品经理申请',
  opportunityId: opportunity.id,
  estimatedMinutes: 30,
  leverage: 80,
  delayCost: 80,
  processStage: 'not_applied',
  status: 'todo',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
}

async function seedWorkspace(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await page.evaluate(async ({ opportunity, action }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 8)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'actions'], 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        transaction.objectStore('opportunities').put(opportunity)
        transaction.objectStore('actions').put(action)
      }
    })
  }, { opportunity, action })

  await page.reload()
  await expect(page.getByRole('heading', { name: action.title })).toBeVisible()
}

async function openBackup(page: Page) {
  await page.getByRole('button', { name: /设置/ }).click()
  await expect(page.getByRole('heading', { name: '偏好、规则、同步与数据安全' })).toBeVisible()
  await page.getByRole('button', { name: '本地备份' }).click()
  await expect(page.getByRole('heading', { name: '备份与恢复' })).toBeVisible()
}

test('closing Backup cancels an armed restore preview and requires explicit file selection again', async ({ page }) => {
  await seedWorkspace(page)
  await openBackup(page)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 JSON 备份' }).click()
  const download = await downloadPromise
  const backupPath = await download.path()
  expect(backupPath).toBeTruthy()

  await page.locator('.backup-file-button input[type="file"]').setInputFiles(backupPath!)
  await expect(page.locator('.backup-preview')).toContainText('岗位 1')
  await expect(page.getByRole('button', { name: '确认恢复' })).toBeVisible()

  await page.locator('.backup-dialog').getByRole('button', { name: '关闭' }).click()
  await expect(page.getByRole('heading', { name: '备份与恢复' })).toHaveCount(0)

  await page.getByRole('button', { name: '本地备份' }).click()
  await expect(page.getByRole('heading', { name: '备份与恢复' })).toBeVisible()
  await expect(page.locator('.backup-preview')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认恢复' })).toHaveCount(0)
  await expect(page.locator('.backup-notice.success')).toHaveCount(0)
  await expect(page.locator('.backup-notice.error')).toHaveCount(0)
})
