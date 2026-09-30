import { test, expect } from '@playwright/test'
import { setupInstantServer } from './fixtures/instantServer.js'
import { INSTANT_NOW } from '../tests/fixtures/instantDenseWorkspace.js'

test.use({ timezoneId: 'Asia/Shanghai' })
test('instant interactions meet p95 budgets without scaling with historical timeline', async ({ browser }, info) => {
  test.setTimeout(150_000)
  const results: any[] = []
  for (const historyRows of [100, 3940]) {
    const context = await browser.newContext({ timezoneId: 'Asia/Shanghai' })
    const server = await setupInstantServer(context, historyRows)
    server.setDelay(10_000)
    const page = await context.newPage()
    await page.clock.setFixedTime(INSTANT_NOW)
    await page.goto('/pjsdas/today')
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['instant-owner']?.lastSyncedVersion)).toBe('txn:1204')
    await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
    // Initial hydration is outside the ordinary command budget.
    await page.evaluate(() => { performance.clearMeasures(); (window as any).commandMeasures = []; window.addEventListener('pjsdas:interaction-measure', event => (window as any).commandMeasures.push((event as CustomEvent).detail)); (window as any).commandLongTasks = []; new PerformanceObserver(list => {
      (window as any).commandLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))
    }).observe({ type: 'longtask' }) })
    const samples: number[] = []
    const acknowledgements: number[] = []
    for (let index = 0; index < 20; index++) {
      await page.locator('.tsui-capacity summary').click()
      const hours = index % 2 === 0 ? '5' : '6'
      await page.getByRole('spinbutton', { name: '今天可用小时' }).fill(hours)
      const sample = await page.evaluate(async hours => {
        const started = performance.now()
        ;(document.querySelector('.tsui-capacity button[type=submit]') as HTMLButtonElement).click()
        while (!document.querySelector('.tsui-capacity summary')?.textContent?.includes(`${hours} 小时`) && performance.now() - started < 5000) await new Promise(requestAnimationFrame)
        const acknowledgement = performance.now() - started
        await new Promise(requestAnimationFrame)
        return { acknowledgement, settled: performance.now() - started }
      }, hours)
      samples.push(sample.settled); acknowledgements.push(sample.acknowledgement)
      await expect(page.locator('.tsui-capacity')).not.toHaveAttribute('open', '')
    }
    const completionSamples: number[] = []
    const undoSamples: number[] = []
    for (let index = 0; index < 10; index++) {
      for (const operation of ['complete', 'undo']) {
        const duration = await page.evaluate(async operation => {
          const started = performance.now()
          const button = operation === 'complete' ? document.querySelector('[data-action-id="dense-action-0"] .tsui-done-action')
            : document.querySelector('.action-undo-toast button')
          if (!button) throw new Error('Missing measured completion control.')
          ;(button as HTMLButtonElement).click()
          while ((operation === 'complete' ? !!document.querySelector('[data-action-id="dense-action-0"]') : !document.querySelector('[data-action-id="dense-action-0"]'))
            && performance.now() - started < 5000) await new Promise(requestAnimationFrame)
          await new Promise(requestAnimationFrame)
          return performance.now() - started
        }, operation)
        ;(operation === 'complete' ? completionSamples : undoSamples).push(duration)
      }
    }
    const measures = await page.evaluate(() => ({ durable: (window as any).commandMeasures.filter((entry: any) => entry.phase === 'durable-outbox').map((entry: any) => entry.durationMs),
      longTasks: (window as any).commandLongTasks }))
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
    const row = { historyRows, bytes: Buffer.byteLength(JSON.stringify(server.snapshot)), acknowledgementP95: p95(acknowledgements),
      settledP95: p95(samples), completionP95: p95(completionSamples), undoP95: p95(undoSamples), durableP95: p95(measures.durable), longTasks: measures.longTasks, samples }
    results.push(row)
    console.log('INSTANT_SAMPLE:' + JSON.stringify(row))
    expect(row.acknowledgementP95).toBeLessThanOrEqual(100)
    expect(row.settledP95).toBeLessThanOrEqual(150)
    expect(row.completionP95).toBeLessThanOrEqual(150)
    expect(row.undoP95).toBeLessThanOrEqual(150)
    expect(row.durableP95).toBeLessThanOrEqual(100)
    expect(measures.longTasks.filter((entry: any) => entry.duration > 50)).toEqual([])
    await context.close()
  }
  // Forty times as many timeline rows must not cause timeline-proportional interaction work.
  expect(results[1].settledP95).toBeLessThanOrEqual(Math.max(100, results[0].settledP95 * 2))
  console.log('INSTANT_INTERACTION_BUDGET:' + JSON.stringify(results))
  await info.attach('instant-interaction-budgets.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
})

test('submission and schedule commands meet dense local p95 budgets while offline', async ({ browser }, info) => {
  test.setTimeout(150_000)
  const results: unknown[] = []
  for (const operation of ['submitted', 'complete', 'cancel', 'reschedule']) {
    const context = await browser.newContext({ timezoneId: 'Asia/Shanghai' })
    await setupInstantServer(context)
    const page = await context.newPage()
    await page.clock.setFixedTime(INSTANT_NOW)
    await page.goto('/pjsdas/today')
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['instant-owner']?.lastSyncedVersion)).toBe('txn:1204')
    if (operation !== 'submitted') await page.getByRole('button', { name: '日程', exact: true }).click()
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); (window as any).denseMeasures = []; window.addEventListener('pjsdas:interaction-measure', event => (window as any).denseMeasures.push((event as CustomEvent).detail)); (window as any).denseLongTasks = []; new PerformanceObserver(list => (window as any).denseLongTasks.push(...list.getEntries().map(entry => entry.duration))).observe({ type: 'longtask' }) })
    const acknowledgement: number[] = [], settled: number[] = []
    for (let index = 0; index < 10; index++) {
      if (operation !== 'submitted') {
        await page.locator('[data-schedule-entry="node:dense-node-0"]').click()
        await page.getByRole('button', { name: operation === 'complete' ? '确认完成' : operation === 'cancel' ? '取消安排' : '改期', exact: true }).click()
        if (operation === 'reschedule') await page.locator('.tsui-schedule-detail input').fill('2026-10-02T22:30')
      }
      const timing = await page.evaluate(async operation => {
        const started = performance.now()
        const control = operation === 'submitted' ? document.querySelector<HTMLButtonElement>('[data-action-id="apply:dense-job-2"] .tsui-done-action')
          : [...document.querySelectorAll<HTMLButtonElement>('.tsui-schedule-detail button')].find(button => button.textContent === '确认' || button.textContent === '确认改期')
        if (!control) throw new Error('Missing measured command control')
        control.click()
        while ((operation === 'submitted' ? !!document.querySelector('[data-action-id="apply:dense-job-2"]') : !!document.querySelector('.tsui-schedule-detail')) && performance.now() - started < 5000) await new Promise(requestAnimationFrame)
        const acknowledgement = performance.now() - started
        await new Promise(requestAnimationFrame)
        return { acknowledgement, settled: performance.now() - started }
      }, operation)
      acknowledgement.push(timing.acknowledgement); settled.push(timing.settled)
      await page.locator(operation === 'submitted' ? '.action-undo-toast button' : '.tsui-schedule-feedback button').click()
      if (operation === 'submitted') await expect(page.locator('[data-action-id="apply:dense-job-2"]')).toBeVisible()
      else await expect(page.locator('[data-schedule-entry="node:dense-node-0"]')).toBeVisible()
    }
    const metrics = await page.evaluate(() => ({ measures: (window as any).denseMeasures, longTasks: (window as any).denseLongTasks }))
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]
    const row = { operation, acknowledgementP95: p95(acknowledgement), settledP95: p95(settled), durableP95: p95(metrics.measures.filter((entry: any) => entry.phase === 'durable-outbox').map((entry: any) => entry.durationMs)), longTasks: metrics.longTasks }
    results.push(row)
    console.log('INSTANT_SAMPLE:' + JSON.stringify(row))
    expect(row.acknowledgementP95).toBeLessThanOrEqual(100)
    expect(row.settledP95).toBeLessThanOrEqual(150)
    expect(row.durableP95).toBeLessThanOrEqual(100)
    expect(metrics.longTasks.filter((duration: number) => duration > 50)).toEqual([])
    await context.close()
  }
  console.log('INSTANT_DOMAIN_BUDGET:' + JSON.stringify(results))
  await info.attach('instant-domain-budgets.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
})
