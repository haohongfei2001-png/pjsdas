export const DEFAULT_TODAY_BUDGET_MINUTES = 180
export const TODAY_BUDGET_OPTIONS = [60, 180, 360] as const
export const TODAY_BUDGET_STORAGE_KEY = 'pjsdas-today-budget-v1'

interface TodayBudgetRecord {
  dateKey: string
  minutes: number
}

export function todayBudgetDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isTodayBudgetOption(value: number): value is typeof TODAY_BUDGET_OPTIONS[number] {
  return (TODAY_BUDGET_OPTIONS as readonly number[]).includes(value)
}

export function loadTodayBudgetMinutes(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
  now = new Date(),
) {
  try {
    const raw = storage.getItem(TODAY_BUDGET_STORAGE_KEY)
    if (!raw) return DEFAULT_TODAY_BUDGET_MINUTES
    const record = JSON.parse(raw) as Partial<TodayBudgetRecord>
    if (record.dateKey !== todayBudgetDateKey(now)) return DEFAULT_TODAY_BUDGET_MINUTES
    if (typeof record.minutes !== 'number' || !isTodayBudgetOption(record.minutes)) return DEFAULT_TODAY_BUDGET_MINUTES
    return record.minutes
  } catch {
    return DEFAULT_TODAY_BUDGET_MINUTES
  }
}

export function saveTodayBudgetMinutes(
  minutes: number,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
  now = new Date(),
) {
  if (!isTodayBudgetOption(minutes)) return false
  try {
    const record: TodayBudgetRecord = { dateKey: todayBudgetDateKey(now), minutes }
    storage.setItem(TODAY_BUDGET_STORAGE_KEY, JSON.stringify(record))
    return true
  } catch {
    // Budget persistence is convenience state only. A storage failure must not
    // break Today planning or mutate durable PJSDAS workspace state.
    return false
  }
}
