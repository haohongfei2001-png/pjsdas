/** Keep retry identity separate from whether this view has requested a preview.
 * Closing a composer cancels presentation, not an uncertain durable admission.
 * This is memory-only; it grants no dispatch or confirmation authority.
 */
export function createAiRequestIdentity() {
  let current: { text: string; accountKey: string; requestId: string } | undefined
  return {
    forInput(text: string, accountKey: string, createId: () => string) {
      if (!current || current.text !== text || current.accountKey !== accountKey) {
        current = { text, accountKey, requestId: createId() }
      }
      return { ...current }
    },
    expire(requestId: string) {
      if (current?.requestId === requestId) current = undefined
    },
  }
}
