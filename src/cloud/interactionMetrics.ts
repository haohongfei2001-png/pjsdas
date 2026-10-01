/** Timing values only; no account identifiers, command payloads or source text. */
export function interactionMetric(phase: string, start: number, extra?: Record<string, number>) {
  const durationMs = performance.now() - start
  try { performance.measure(`todayaction:${phase}`, { start, end: performance.now() }) } catch { /* optional browser instrumentation */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pjsdas:interaction-measure', { detail: { phase, durationMs, ...extra } }))
}
