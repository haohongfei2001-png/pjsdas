export async function enforceConnectedAccountCacheBoundary(
  currentOwnerUserId: string | undefined,
  nextUserId: string | undefined,
  clearCache: () => Promise<void>,
  clearBinding: () => void,
) {
  if (!currentOwnerUserId || currentOwnerUserId === nextUserId) return false
  await clearCache()
  clearBinding()
  return true
}
