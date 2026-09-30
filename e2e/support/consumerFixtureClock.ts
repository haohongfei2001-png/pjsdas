import type { Page } from '@playwright/test'

// A Today fixture needs a known physical work window. Keep Date deterministic
// while animation frames, timers and performance measurements remain real.
export async function freezeTodayFixture(page: Page) {
  await page.clock.setFixedTime(new Date('2026-09-30T06:00:00Z'))
}
