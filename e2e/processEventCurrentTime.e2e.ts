import { expect, test, type Page } from '@playwright/test'

const opportunity = {
  id: 'process-time-opportunity',
  company: '时钟科技',
  role: 'AI产品经理',
  currentStageLabel: '待投递',
  processStage: 'not_applied',
  roleType: 'core',
  early: false,
  opportunityValue: 80,
  fitScore: 80,
  locallyManaged: true,
  importedAt: '2026-09-14T00:00:00.000Z',
}

async function seedOpportunity(page: Page) {
  await page.evaluate(async (item) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 8)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction('opportunities', 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        transaction.objectStore('opportunities').put(item)
      }
    })
  }, opportunity)
}

async function currentLocalDateTimeValue(page: Page) {
  return page.evaluate(() => {
    const date = new Date()
    const offset = date.getTimezoneOffset() * 60_000
    return new Date(date.getTime() - offset).toISOString().slice(0, 16)
  })
}

test('process-event notification default refreshes on open but preserves an explicit user edit', async ({ page }) => {
  await page.addInitScript({
    content: `
      (() => {
        const NativeDate = Date;
        let now = NativeDate.parse('2026-09-14T08:00:00.000Z');
        function MockDate(...args) {
          if (new.target) return args.length ? new NativeDate(...args) : new NativeDate(now);
          return new NativeDate(now).toString();
        }
        MockDate.now = () => now;
        MockDate.parse = NativeDate.parse;
        MockDate.UTC = NativeDate.UTC;
        MockDate.prototype = NativeDate.prototype;
        window.Date = MockDate;
        window.__setPjsdasTestNow = (iso) => { now = NativeDate.parse(iso); };
      })();
    `,
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()
  await seedOpportunity(page)

  await page.evaluate(() => {
    ;(window as unknown as { __setPjsdasTestNow: (iso: string) => void })
      .__setPjsdasTestNow('2026-09-14T13:45:00.000Z')
  })

  await page.getByRole('button', { name: '+ 记录流程通知' }).click()
  await expect(page.getByRole('heading', { name: '记录真实流程通知' })).toBeVisible()

  const receivedInput = page.locator('.event-form input[type="datetime-local"]').first()
  await expect(receivedInput).toHaveValue(await currentLocalDateTimeValue(page))

  await receivedInput.fill('2026-09-14T09:30')
  await page.getByRole('button', { name: '关闭' }).click()

  await page.evaluate(() => {
    ;(window as unknown as { __setPjsdasTestNow: (iso: string) => void })
      .__setPjsdasTestNow('2026-09-14T15:00:00.000Z')
  })
  await page.getByRole('button', { name: '+ 记录流程通知' }).click()
  await expect(receivedInput).toHaveValue('2026-09-14T09:30')
})
