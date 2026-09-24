export function shouldInitializeCaptureForSession(
  initializedUserId: string | null | undefined,
  nextUserId: string | undefined,
) {
  if (initializedUserId === undefined) return true
  if (!nextUserId) return false
  return nextUserId !== initializedUserId
}
