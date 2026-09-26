import { expect, test, type Page } from '@playwright/test'
import { invokeCoverageStatus } from '../gateway/coverageTool.js'
import { buildIngestionRunSummary, createIngestionLedgerTimeline, createIngestionRunTimeline, PJSDAS_EXPECTED_INGESTION_SOURCES } from '../src/ingestion.js'
import { reconcileIngestionDebt } from '../src/ingestionResolution.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { opportunity } from './fixtures/todayWorkspace.js'

const NOW = new Date('2026-09-27T00:00:00.000Z')

function fixture(active: boolean) {
  const ledger = (id: string, extra: Partial<Parameters<typeof createIngestionLedgerTimeline>[0]> = {}) => createIngestionLedgerTimeline({
    sourceKind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: id,
    runId: `old:${id}`, recordType: 'recruiting_message', outcome: 'unresolved',
    fingerprint: `fp:${id}`, receivedAt: '2026-08-01T00:00:00.000Z', accountedAt: '2026-08-01T00:00:00.000Z', ...extra,
  })
  const history = [
    ledger('fragment-limit', { opportunityId: 'closed', reason: 'Interpretation fragment limit exceeded.' }),
    ledger('old-reminder', { opportunityId: 'closed' }),
    ledger('marketing', { reason: 'Generic recruiting ad / marketing newsletter; no actionable business fact.' }),
    ledger('replay'),
    ledger('replay', { outcome: 'duplicate', runId: 'later:replay', accountedAt: '2026-09-26T00:00:00.000Z' }),
  ]
  if (active) history.push(ledger('multi-role', { company: 'Example' }), ledger('live-ambiguity', { opportunityId: 'live' }))
  const runs = PJSDAS_EXPECTED_INGESTION_SOURCES.map((source) => createIngestionRunTimeline(buildIngestionRunSummary({
    runId: `fresh:${source.sourceId}`, sourceKind: source.sourceKind, sourceId: source.sourceId,
    producer: 'server_scheduler', startedAt: NOW.toISOString(), completedAt: NOW.toISOString(), records: [],
    sourcePolicy: { version: 1, enabled: true, cadenceMinutes: 10, freshnessSlaMinutes: 20, label: source.label },
  })))
  const base = createSnapshot({
    opportunities: [opportunity('closed', 'Closed', 'Product'), opportunity('live', 'Live', 'Product'), opportunity('role-a', 'Example', 'A'), opportunity('role-b', 'Example', 'B')],
    processes: [{ id: 'closed-process', opportunityId: 'closed', company: 'Closed', role: 'Product', stage: 'closed', stageLabel: 'Closed', progress: 'completed', result: 'rejected', participationState: 'active' }],
    processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [...history, ...runs],
  }, NOW.toISOString())
  const reconciled = reconcileIngestionDebt(base, NOW)
  expect(reconcileIngestionDebt(reconciled.snapshot, NOW).changed).toBe(false)
  expect(reconciled.snapshot.data.timeline.filter((row) => row.ingestion)).toEqual(history)
  return reconciled.snapshot
}

async function mountCoverage(page: Page, snapshot?: PJSDASSnapshot) {
  await page.evaluate(async (input) => {
    const entry = document.querySelector<HTMLScriptElement>('script[src*="/src/main.tsx"]')
    if (!entry) throw new Error('Vite browser entry is missing')
    const base = new URL(entry.src).pathname.replace('src/main.tsx', '')
    const modulePath = `${base}e2e/fixtures/coverageHarness.tsx`
    const harness = await import(modulePath)
    await harness.mount(input)
  }, snapshot)
  await page.locator('#r02-coverage-browser-harness .coverage-pill').click()
}

for (const active of [false, true]) test(`R02 durable Coverage UI/API: active debt ${active ? 'blocks' : 'cleared with lifetime audit retained'}`, async ({ page }) => {
  const snapshot = fixture(active)
  const api = await invokeCoverageStatus({ async read() { return { snapshot, context: { workspaceVersion: 'txn:r02-synthetic', now: NOW } } } })
  expect(api.isError).not.toBe(true)
  expect(api.structuredContent?.coverage).toMatchObject({ activeUnresolvedCount: active ? 2 : 0, lifetimeUnresolvedCount: active ? 6 : 4, allCaughtUp: !active })
  await page.clock.setFixedTime(NOW)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  await mountCoverage(page, snapshot)
  const panel = page.locator('#r02-coverage-browser-harness')
  await expect(panel.locator('.coverage-summary > div').filter({ hasText: 'Active unresolved' }).locator('strong')).toHaveText(active ? '2' : '0')
  await expect(panel.locator('.coverage-summary > div').filter({ hasText: 'Lifetime unresolved audit' }).locator('strong')).toHaveText(active ? '6' : '4')
  await expect(panel.locator('.coverage-indicator')).toHaveClass(active ? /attention/ : /ok/)
  if (active) await expect(panel).toContainText('Only currently active unresolved items appear here.')
  else await expect(panel).toContainText('Lifetime audit still retains 4 historically unresolved source record(s).')
  await page.reload()
  await mountCoverage(page)
  await expect(panel.locator('.coverage-summary > div').filter({ hasText: 'Lifetime unresolved audit' }).locator('strong')).toHaveText(active ? '6' : '4')
  await expect(panel.locator('.coverage-indicator')).toHaveClass(active ? /attention/ : /ok/)
})
