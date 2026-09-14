import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TODAY_BUDGET_MINUTES,
  loadTodayBudgetMinutes,
  saveTodayBudgetMinutes,
  TODAY_BUDGET_STORAGE_KEY,
  todayBudgetDateKey,
} from '../src/todayBudget.js'

function memoryStorage(initial?: string) {
  let value = initial ?? null
  return {
    getItem(key: string) {
      return key === TODAY_BUDGET_STORAGE_KEY ? value : null
    },
    setItem(key: string, next: string) {
      if (key === TODAY_BUDGET_STORAGE_KEY) value = next
    },
    value: () => value,
  }
}

describe('Today budget state', () => {
  it('keeps a selected budget across same-day remount/reload state', () => {
    const storage = memoryStorage()
    const now = new Date(2026, 8, 14, 12, 0, 0)
    expect(saveTodayBudgetMinutes(60, storage, now)).toBe(true)
    expect(loadTodayBudgetMinutes(storage, new Date(2026, 8, 14, 21, 30, 0))).toBe(60)
  })

  it('resets an old-day budget to the product default on a new local date', () => {
    const storage = memoryStorage(JSON.stringify({
      dateKey: todayBudgetDateKey(new Date(2026, 8, 14, 23, 30, 0)),
      minutes: 360,
    }))
    expect(loadTodayBudgetMinutes(storage, new Date(2026, 8, 15, 0, 5, 0)))
      .toBe(DEFAULT_TODAY_BUDGET_MINUTES)
  })

  it('fails soft on invalid/corrupt convenience state', () => {
    expect(loadTodayBudgetMinutes(memoryStorage('{broken'), new Date(2026, 8, 14)))
      .toBe(DEFAULT_TODAY_BUDGET_MINUTES)
    const storage = memoryStorage()
    expect(saveTodayBudgetMinutes(999, storage, new Date(2026, 8, 14))).toBe(false)
    expect(storage.value()).toBeNull()
  })
})
