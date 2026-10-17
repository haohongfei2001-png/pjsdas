/** Diagnostics must neither run on success nor replace the original failure. */
export async function withFailureDiagnostic(check: () => Promise<unknown>, attach: () => Promise<unknown>) {
  try { await check() }
  catch (original) {
    try { await attach() } catch { /* Preserve the assertion even if diagnostics are unavailable. */ }
    throw original
  }
}
