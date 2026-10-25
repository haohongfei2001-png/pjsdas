/** Per-invocation work reuse only: never stores opportunities, parse results,
 * message clocks or user identities. A budget is shared by all maps in a scope.
 * When full, keep the original computation; never truncate an identity. */
export const NOTIFICATION_MEMO_MAX_ENTRIES = 2048
export const NOTIFICATION_MEMO_MAX_KEY_CHARS = 512
export const NOTIFICATION_MEMO_MAX_RETAINED_CHARS = 512 * 1024

type IdentityValue = string | readonly string[]

export function createNotificationIdentityMemo() {
  let retainedChars = 0
  return <T extends IdentityValue>(compute: (key: string) => T) => {
    const values = new Map<string, T>()
    return (key: string): T => {
      const previous = values.get(key)
      if (previous !== undefined) return previous
      const value = compute(key)
      if (key.length > NOTIFICATION_MEMO_MAX_KEY_CHARS || values.size >= NOTIFICATION_MEMO_MAX_ENTRIES) return value
      // Conservative UTF-16 accounting includes both keys and every alias,
      // even if the engine happens to share their underlying string storage.
      const cost = key.length + (typeof value === 'string' ? value.length : value.reduce((sum, alias) => sum + alias.length, 0))
      if (retainedChars + cost > NOTIFICATION_MEMO_MAX_RETAINED_CHARS) return value
      retainedChars += cost
      if (Array.isArray(value)) Object.freeze(value)
      values.set(key, value)
      return value
    }
  }
}
