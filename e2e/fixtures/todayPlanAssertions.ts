import { expect, type Page } from '@playwright/test'
import { selectTodayWeb } from '../../src/today/todayWebSelector.js'

/** Assert visibility separately from the unchanged capacity recommendation.
 * Read the actual retained browser workspace, not a second synthetic plan. */
export async function expectTodayPlan(page: Page, recommendedIds: string[], visibleCount: number) {
  const read = async () => {
    const current = await page.evaluate(async () => ({
      snapshot: await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot(),
      now: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }))
    return { ...current, selection: selectTodayWeb(current.snapshot, {}, { now: new Date(current.now), timezone: current.timezone }) }
  }
  // A capacity autosave or another client's refresh can finish after the unchanged
  // full card count has rendered. Wait for the actual recommended subset too.
  await expect.poll(async () => (await read()).selection.actions.map(item => item.actionId)).toEqual(recommendedIds)
  const current = await read()
  const cards = page.locator('.tsui-task-panel [data-action-id]')
  await expect(cards).toHaveCount(visibleCount)
  expect(await cards.evaluateAll(items => items.map(item => item.getAttribute('data-action-id'))))
    .toEqual(current.selection.visibleActions.map(item => item.actionId))
  // Recommendation membership remains a read-model fact, not an extra UI badge.
  const visibleIds = current.selection.visibleActions.map(item => item.actionId)
  expect([...current.selection.insufficientTimeActionIds].sort())
    .toEqual(visibleIds.filter(id => !recommendedIds.includes(id)).sort())
  await expect(page.locator('.tsui-task-panel [data-capacity-limited-action-id]')).toHaveCount(0)
  return current.snapshot
}
