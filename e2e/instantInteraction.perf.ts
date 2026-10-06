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
    // Native constructor timestamps bypass Playwright's mocked performance object.
    // Diagnostic-only: preserve all tasks, samples and assertions.
    await page.evaluate(() => {
    const nativeNow = () => new PerformanceMark('ta-native-diagnostic').startTime
    const state = { clock: 'native PerformanceMark constructor', installedAt: nativeNow(), observerInstalledAt: 0,
      clockPairs: [{ native: nativeNow(), fixture: performance.now() }], inputs: [] as { type: string; target: string; handlerEntry: number }[],
      stageHandlerEntries: [] as { phase: string; handlerEntry: number }[], commandWindows: [] as { operation: string; start: number; end: number }[] }
    ;(window as any).nativeTimingDiagnostic = state
    ;(window as any).nativeTimingNow = nativeNow
    for (const type of ['pointerdown', 'click', 'input']) window.addEventListener(type, event => {
      if (state.inputs.length < 1000) state.inputs.push({ type, target: event.target instanceof Element ? event.target.tagName : 'unknown', handlerEntry: nativeNow() })
    }, { capture: true })
    window.addEventListener('pjsdas:interaction-measure', event => {
      if (state.stageHandlerEntries.length < 2000) state.stageHandlerEntries.push({ phase: (event as CustomEvent).detail.phase, handlerEntry: nativeNow() })
    })
      performance.clearMeasures(); (window as any).commandMeasures = []; window.addEventListener('pjsdas:interaction-measure', event => (window as any).commandMeasures.push((event as CustomEvent).detail)); (window as any).commandLongTasks = []; (window as any).capacityCommandWindows = []; new PerformanceObserver(list => {
      (window as any).commandLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))
    }).observe({ type: 'longtask' }); (window as any).nativeTimingDiagnostic.observerInstalledAt = (window as any).nativeTimingNow() })
    const samples: number[] = []
    const acknowledgements: number[] = []
    for (let index = 0; index < 20; index++) {
      await page.locator('.tsui-capacity summary').click()
      const hours = index % 2 === 0 ? '5' : '6'
      await page.getByRole('spinbutton', { name: '今天可用小时' }).fill(hours)
      const sample = await page.evaluate(async hours => {
        const nativeStarted = (window as any).nativeTimingNow()
        const started = performance.now()
        ;(document.querySelector('.tsui-capacity form') as HTMLFormElement).requestSubmit()
        while (!document.querySelector('.tsui-capacity summary')?.textContent?.includes(`${hours} 小时`) && performance.now() - started < 5000) await new Promise(requestAnimationFrame)
        const acknowledgement = performance.now() - started
        await new Promise(requestAnimationFrame)
        const ended = performance.now(); (window as any).nativeTimingDiagnostic.commandWindows.push({ start: nativeStarted, end: (window as any).nativeTimingNow(), operation: 'capacity' }); (window as any).capacityCommandWindows.push({ start: started, end: ended, operation: 'capacity' }); return { acknowledgement, settled: ended - started }
      }, hours)
      samples.push(sample.settled); acknowledgements.push(sample.acknowledgement)
      await expect(page.locator('.tsui-capacity')).not.toHaveAttribute('open', '')
    }
    const completionSamples: number[] = []
    const undoSamples: number[] = []
    for (let index = 0; index < 10; index++) {
      for (const operation of ['complete', 'undo']) {
        const duration = await page.evaluate(async operation => {
          const nativeStarted = (window as any).nativeTimingNow()
          const started = performance.now()
          const button = operation === 'complete' ? document.querySelector('[data-action-id="dense-action-0"] .tsui-done-action')
            : document.querySelector('.action-undo-toast button')
          if (!button) throw new Error('Missing measured completion control.')
          ;(button as HTMLButtonElement).click()
          while ((operation === 'complete' ? !!document.querySelector('[data-action-id="dense-action-0"]') : !document.querySelector('[data-action-id="dense-action-0"]'))
            && performance.now() - started < 5000) await new Promise(requestAnimationFrame)
          await new Promise(requestAnimationFrame)
          const ended = performance.now(); (window as any).nativeTimingDiagnostic.commandWindows.push({ start: nativeStarted, end: (window as any).nativeTimingNow(), operation }); (window as any).capacityCommandWindows.push({ start: started, end: ended, operation }); return ended - started
        }, operation)
        ;(operation === 'complete' ? completionSamples : undoSamples).push(duration)
      }
    }
    const measures = await page.evaluate(() => {
      (window as any).nativeTimingDiagnostic.clockPairs.push({ native: (window as any).nativeTimingNow(), fixture: performance.now() })
      return { durable: (window as any).commandMeasures.filter((entry: any) => entry.phase === 'durable-outbox').map((entry: any) => entry.durationMs),
      nativeDiagnostic: (window as any).nativeTimingDiagnostic, longTasks: (window as any).commandLongTasks, stages: (window as any).commandMeasures, commandWindows: (window as any).capacityCommandWindows } })
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
    const row = { historyRows, bytes: Buffer.byteLength(JSON.stringify(server.snapshot)), acknowledgementP95: p95(acknowledgements),
      settledP95: p95(samples), completionP95: p95(completionSamples), undoP95: p95(undoSamples), durableP95: p95(measures.durable), longTasks: measures.longTasks, samples }
    await info.attach(`instant-${historyRows}-stages.json`, { body: JSON.stringify(measures), contentType: 'application/json' })
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
    if (operation !== 'submitted') {
      await page.getByRole('button', { name: '日程', exact: true }).click()
      await expect(page.locator('[data-schedule-entry="node:dense-node-0"]')).toBeVisible()
    }
    else await expect(page.locator('[data-action-id="apply:dense-job-2"] .tsui-done-action')).toBeVisible()
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); (window as any).denseMeasures = []; window.addEventListener('pjsdas:interaction-measure', event => (window as any).denseMeasures.push((event as CustomEvent).detail)); (window as any).denseLongTasks = []; (window as any).denseCommandWindows = []; new PerformanceObserver(list => (window as any).denseLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask' }) })
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
        const ended = performance.now()
        ;(window as any).denseCommandWindows.push({ start: started, end: ended, operation })
        return { acknowledgement, settled: ended - started }
      }, operation)
      acknowledgement.push(timing.acknowledgement); settled.push(timing.settled)
      await page.evaluate(async operation => {
        const start = performance.now()
        const button = document.querySelector<HTMLButtonElement>(operation === 'submitted' ? '.action-undo-toast button' : '.tsui-schedule-feedback button')
        if (!button) throw new Error('Missing measured Undo control')
        button.click()
        while (!(operation === 'submitted' ? document.querySelector('[data-action-id="apply:dense-job-2"]') : document.querySelector('[data-schedule-entry="node:dense-node-0"]')) && performance.now() - start < 5000) await new Promise(requestAnimationFrame)
        await new Promise(requestAnimationFrame)
        ;(window as any).denseCommandWindows.push({ start, end: performance.now(), operation: 'undo' })
      }, operation)
      if (operation === 'submitted') await expect(page.locator('[data-action-id="apply:dense-job-2"]')).toBeVisible()
      else await expect(page.locator('[data-schedule-entry="node:dense-node-0"]')).toBeVisible()
    }
    const metrics = await page.evaluate(() => ({ measures: (window as any).denseMeasures, allLongTasks: (window as any).denseLongTasks, commandWindows: (window as any).denseCommandWindows,
      longTasks: (window as any).denseLongTasks.filter((task: any) => (window as any).denseCommandWindows.some((window: any) => task.start < window.end && task.start + task.duration > window.start)).map((task: any) => task.duration) }))
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]
    const row = { operation, acknowledgementSamples: acknowledgement, settledSamples: settled, durableSamples: metrics.measures.filter((entry: any) => entry.phase === 'durable-outbox').map((entry: any) => entry.durationMs), acknowledgementP95: p95(acknowledgement), settledP95: p95(settled), durableP95: p95(metrics.measures.filter((entry: any) => entry.phase === 'durable-outbox').map((entry: any) => entry.durationMs)), longTasks: metrics.longTasks }
    await info.attach(`instant-${operation}-stages.json`, { body: JSON.stringify(metrics), contentType: 'application/json' })
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


test('ordinary compact confirmation and Undo stay incremental without command long tasks', async ({ browser }, info) => {
  const context = await browser.newContext({ timezoneId: 'Asia/Shanghai' })
  const server = await setupInstantServer(context); server.setDelay(50)
  const page = await context.newPage(); await page.clock.setFixedTime(INSTANT_NOW)
  await page.goto('/pjsdas/today')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}').accounts?.['instant-owner']?.lastSyncedVersion)).toBe('txn:1204')
  await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
  // Cold hydration is excluded; every optimistic write and confirmation below
  // is measured, including IDB reconciliation and selector work after the RTT.
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).confirmationStages = []; (window as any).confirmationLongTasks = []
    window.addEventListener('pjsdas:interaction-measure', event => (window as any).confirmationStages.push((event as CustomEvent).detail))
    new PerformanceObserver(list => (window as any).confirmationLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask' })
  })
  // Optional diagnostic capture is separate from the strict unprofiled gate.
  const cdp = process.env.INSTANT_CONFIRMATION_TRACE === '1' ? await context.newCDPSession(page) : undefined
  if (cdp) await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,disabled-by-default-v8.gc,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler', transferMode: 'ReturnAsStream' })
  const pending = () => page.evaluate(() => JSON.parse(localStorage.getItem('pjsdas-cgr01-pending:instant-owner') ?? '[]').length)
  for (let index = 0; index < 10; index++) {
    await page.locator('[data-action-id="dense-action-0"] .tsui-done-action').click()
    await expect(page.locator('[data-action-id="dense-action-0"]')).toHaveCount(0)
    await expect.poll(pending).toBe(0)
    await page.locator('.action-undo-toast button').click()
    await expect(page.locator('[data-action-id="dense-action-0"]')).toBeVisible()
    await expect.poll(pending).toBe(0)
  }
  if (cdp) {
    const complete = new Promise<any>(resolve => cdp.once('Tracing.tracingComplete', resolve))
    await cdp.send('Tracing.end'); const { stream } = await complete
    let body = ''
    while (true) { const chunk = await cdp.send('IO.read', { handle: stream }); body += chunk.data; if (chunk.eof) break }
    await cdp.send('IO.close', { handle: stream })
    await info.attach('compact-confirmation-native-trace.json', { body, contentType: 'application/json' })
  }
  const measured = await page.evaluate(() => ({ stages: (window as any).confirmationStages, longTasks: (window as any).confirmationLongTasks,
    phaseEntries: performance.getEntriesByType('measure').filter(entry => entry.name.startsWith('todayaction:')).map(entry => ({ name: entry.name, start: entry.startTime, duration: entry.duration })) }))
  await info.attach('compact-confirmation-stages.json', { body: JSON.stringify({ ...measured, payloadBytes: server.payloadBytes, serverExecutionMs: server.serverExecutionMs }, null, 2), contentType: 'application/json' })
  expect(server.sent).toHaveLength(20)
  expect(new Set(server.sent).size).toBe(20)
  expect(measured.stages.filter((entry: any) => entry.phase === 'network-confirmation')).toHaveLength(20)
  expect(Math.max(...server.payloadBytes)).toBeLessThan(150000)
  expect(measured.longTasks.filter((entry: any) => entry.duration > 50)).toEqual([])
  expect(server.snapshot.data.timeline!.length).toBeGreaterThanOrEqual(3940)
  console.log('INSTANT_CONFIRMATION_BUDGET:' + JSON.stringify({ commands: server.sent.length, maxPayloadBytes: Math.max(...server.payloadBytes), longTasks: measured.longTasks }))
  await context.close()
})
