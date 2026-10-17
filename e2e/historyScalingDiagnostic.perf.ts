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
    // DIAGNOSTIC_ONLY: start sampling before navigation so no instrumentation
    // await shifts the original post-hydration observer/first-input boundary.
    const cdp = await context.newCDPSession(page)
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,disabled-by-default-v8.gc,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler', transferMode: 'ReturnAsStream' })
    try {
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
    } finally {
      const complete = new Promise<any>(resolve => cdp.once('Tracing.tracingComplete', resolve))
      await cdp.send('Tracing.end'); const { stream } = await complete
      let body = ''
      while (true) { const chunk = await cdp.send('IO.read', { handle: stream }); body += chunk.data; if (chunk.eof) break }
      await cdp.send('IO.close', { handle: stream })
      await info.attach(`history-${historyRows}-native-trace.json`, { body, contentType: 'application/json' })
      await cdp.detach()
      await context.close()
    }
  }
  // Forty times as many timeline rows must not cause timeline-proportional interaction work.
  expect(results[1].settledP95).toBeLessThanOrEqual(Math.max(100, results[0].settledP95 * 2))
  console.log('INSTANT_INTERACTION_BUDGET:' + JSON.stringify(results))
  await info.attach('instant-interaction-budgets.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
})

