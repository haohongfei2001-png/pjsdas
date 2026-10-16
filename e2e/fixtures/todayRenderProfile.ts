import type { Page, TestInfo } from '@playwright/test'

/** Opt-in diagnostics only. The ordinary performance gate makes no CDP calls. */
export async function startTodayRenderProfile(page: Page, info: TestInfo) {
  if (process.env.TODAY_RENDER_PROFILE !== '1') return undefined
  const client = await page.context().newCDPSession(page)
  await client.send('Performance.enable')
  const tracing = process.env.TODAY_RENDER_TRACE === '1'
  if (tracing) await client.send('Tracing.start', {
    categories: 'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-v8.cpu_profiler',
    transferMode: 'ReturnAsStream',
  })
  const samples: unknown[] = []
  let sequence = 0
  const metrics = async () => new Map((await client.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]))
  return {
    async measure(label: string, runOriginalMeasurement: () => Promise<number>) {
      const id = `${++sequence}:${label}`
      const offset = await page.evaluate(id => {
        performance.mark(`today-render-profile:${id}:begin`)
        return performance.getEntriesByType('measure').length
      }, id)
      const before = await metrics()
      // The original click, target wait, two animation frames and elapsed return
      // stay together and unchanged. Diagnostics run outside that timed callback.
      const elapsedMs = await runOriginalMeasurement()
      const after = await metrics()
      const observed = await page.evaluate(({ id, offset }) => {
        performance.mark(`today-render-profile:${id}:end`)
        return {
          phases: performance.getEntriesByType('measure').slice(offset)
            .filter(item => item.name.startsWith('todayaction:'))
            .map(item => ({ name: item.name, startTime: item.startTime, endTime: item.startTime + item.duration, durationMs: item.duration })),
          now: new Date().toISOString(),
          taskRows: document.querySelectorAll('.tsui-task-row').length,
          limitedRows: document.querySelectorAll('[data-capacity-limited-action-id]').length,
          nodeRows: document.querySelectorAll('.tsui-node-row').length,
        }
      }, { id, offset })
      const durations = ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration']
      const counts = ['LayoutCount', 'RecalcStyleCount']
      const sample = { id, elapsedMs, ...observed,
        cdpWindowSeconds: { start: before.get('Timestamp'), end: after.get('Timestamp') },
        cdpDurationMs: Object.fromEntries(durations.map(name => [name, ((after.get(name) ?? 0) - (before.get(name) ?? 0)) * 1000])),
        cdpCountDelta: Object.fromEntries(counts.map(name => [name, (after.get(name) ?? 0) - (before.get(name) ?? 0)])),
        domNodes: after.get('Nodes'), jsHeapUsedBytes: after.get('JSHeapUsedSize'),
      }
      samples.push(sample)
      console.log(`TODAY_RENDER_PROFILE:${JSON.stringify(sample)}`)
      return elapsedMs
    },
    async finish() {
      await info.attach('today-render-profile.json', { body: JSON.stringify({
        diagnosticOnly: true, samplingOverhead: true,
        note: 'CDP windows include protocol/observation overhead. Standard non-profiled CI remains authoritative.', samples,
      }, null, 2), contentType: 'application/json' })
      if (tracing) {
        const completed = new Promise<{ stream?: string }>(resolve => client.once('Tracing.tracingComplete', resolve))
        await client.send('Tracing.end')
        const { stream } = await completed
        if (stream) {
          const chunks: Buffer[] = []
          for (;;) {
            const chunk = await client.send('IO.read', { handle: stream })
            chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'))
            if (chunk.eof) break
          }
          await client.send('IO.close', { handle: stream })
          await info.attach('today-render-browser-trace.json', { body: Buffer.concat(chunks), contentType: 'application/json' })
        }
      }
      await client.detach()
    },
  }
}
