import { semanticContextKey } from '../semanticCompletionContext.js'
/** Keep retry identity separate from whether this view has requested a preview.
 * Closing a composer cancels presentation, not an uncertain durable admission.
 * This is memory-only; it grants no dispatch or confirmation authority.
 */
export function createAiRequestIdentity() {
  let current: { text: string; accountKey: string; requestId: string; contextRefs?: readonly string[] } | undefined
  return {
    forInput(text: string, accountKey: string, createId: () => string, contextRefs: readonly string[] = []) {
      if (!current || current.text !== text || current.accountKey !== accountKey || semanticContextKey(current.contextRefs) !== semanticContextKey(contextRefs)) {
        current = { text, accountKey, requestId: createId(), ...(contextRefs.length ? { contextRefs: Object.freeze(JSON.parse(semanticContextKey(contextRefs)) as string[]) } : {}) }
      }
      return { ...current }
    },
    expire(requestId: string) {
      if (current?.requestId === requestId) current = undefined
    },
  }
}
