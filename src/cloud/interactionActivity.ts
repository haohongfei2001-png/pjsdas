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
