/** Reserved for server-created synthetic review grants; legacy notes are unchanged. */
export const CONSUMER_REVIEW_NOTE_PREFIX = 'TA_REVIEW_V7|'
export function consumerReviewLeaseAllows(note: string | null | undefined, grantedAt: string | null | undefined, now = Date.now()) {
  if (!note?.startsWith(CONSUMER_REVIEW_NOTE_PREFIX)) return true
  const fields = note.split('|')
  if (fields.length !== 3 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fields[2])) return false
  const expires = Date.parse(fields[1]), granted = Date.parse(grantedAt ?? '')
  return Number.isFinite(expires) && Number.isFinite(granted) && new Date(expires).toISOString() === fields[1]
    && expires > granted && expires - granted <= 24 * 60 * 60 * 1000 && now < expires
}
