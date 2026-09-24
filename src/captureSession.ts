export type CaptureSessionTransition = 'initialize' | 'adopt' | 'ignore'

export function captureSessionTransition(
  initializedUserId: string | null | undefined,
  nextUserId: string | undefined,
  hasCurrentText: boolean,
): CaptureSessionTransition {
  if (initializedUserId === undefined) return 'initialize'
  if (!nextUserId) return 'ignore'
  if (initializedUserId === nextUserId) return 'ignore'
  if (initializedUserId === null && hasCurrentText) return 'adopt'
  return 'initialize'
}
