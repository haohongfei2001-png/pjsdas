/** In-memory scheduling only; never authority or a cache-equivalence proof. */
const recent = new Map<string, number>()
const QUIET_PERIOD_MS = 1000
export function markInteractionActivity(accountKey: string) {
  recent.set(accountKey, performance.now())
  if (recent.size > 16) recent.delete(recent.keys().next().value!)
}
export function interactionIsRecent(accountKey: string) {
  const at = recent.get(accountKey)
  if (at === undefined) return false
  const age = performance.now() - at
  return age >= 0 && age < QUIET_PERIOD_MS
}

/** Observe input intent before focus-triggered passive refreshes can do full reads.
 * This is only scheduling: explicit reads and conflict recovery retain their guards.
 */
export function observeInteractionActivity(accountKey: string, target: EventTarget): () => void {
  const events = ['pointerdown', 'keydown', 'input'] as const
  const mark = () => markInteractionActivity(accountKey)
  for (const event of events) target.addEventListener(event, mark, { capture: true, passive: true })
  return () => { for (const event of events) target.removeEventListener(event, mark, { capture: true }) }
}
