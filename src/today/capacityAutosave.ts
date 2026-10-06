/** A quiet edit is accepted after a short pause; blur/Enter/presets commit immediately. */
export const CAPACITY_AUTOSAVE_DELAY_MS = 450
export type CapacitySaveIntent = { minutes: number; scope: string }
export type CapacitySaveState = { pending: boolean; intent?: CapacitySaveIntent; error?: unknown; outdated?: boolean }

export function capacityMinutesFromHours(value: string): number | undefined {
  if (!value.trim()) return undefined
  const hours = Number(value)
  return Number.isFinite(hours) && hours >= 0 && hours <= 24 ? Math.round(hours * 60) : undefined
}

/** Serialize durable writes; a slower old completion must never replace a newer edit. */
export function createCapacityAutosaver(save: (intent: CapacitySaveIntent) => Promise<void>, notify: (state: CapacitySaveState) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let next: { intent: CapacitySaveIntent; version: number; epoch: number } | undefined
  let running = false, ready = false, version = 0, epoch = 0, listening = true
  const emit = (state: CapacitySaveState) => { if (listening) notify(state) }
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  const drain = async () => {
    if (running || !ready || !next) return
    const work = next
    next = undefined; ready = false; running = true
    try {
      await save(work.intent)
      if (work.version === version) emit({ pending: false, intent: work.intent })
    } catch (error) {
      if (work.epoch === epoch && (work.version === version || !next)) {
        emit({ pending: false, intent: work.intent, error, ...(work.version === version ? {} : { outdated: true }) })
      }
    } finally {
      running = false
      if (ready && next) void drain()
    }
  }
  const flush = () => { clearTimer(); ready = true; void drain() }
  return {
    schedule(intent: CapacitySaveIntent) {
      clearTimer(); next = { intent, version: ++version, epoch }; ready = false
      emit({ pending: true, intent })
      timer = setTimeout(flush, CAPACITY_AUTOSAVE_DELAY_MS)
    },
    flush,
    cancelDraft() { clearTimer(); next = undefined; ready = false; ++version; emit({ pending: false }) },
    cancel() { clearTimer(); next = undefined; ready = false; ++version; ++epoch; emit({ pending: false }) },
    // A navigation blur accepts the last valid edit. Finish its serialized write
    // without updating an unmounted component; the owner revalidates scope at save time.
    attach() { listening = true },
    detach() { listening = false; flush() },
  }
}
