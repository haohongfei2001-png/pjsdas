export const MOCK_BACKEND_ORIGIN = 'https://todayaction-backend.invalid'
export const MOCK_AUTH_ORIGIN = 'https://todayaction-auth.invalid'
export const MOCK_AUTH_STORAGE_KEY = 'todayaction-mock-auth-v1'

/** Vite's mode, not NODE_ENV: perf tests use the production React runtime
 * inside a development server. Only an explicit live opt-in enables that
 * server to contact real cloud services. Ordinary production builds retain
 * their existing live behavior. */
export function resolveCloudMode(env: Record<string, unknown>): 'mock' | 'live' {
  const mode = typeof env.VITE_PJSDAS_CLOUD_MODE === 'string' ? env.VITE_PJSDAS_CLOUD_MODE.trim() : ''
  if (mode === 'mock' || mode === 'live') return mode
  if (mode) return 'mock'
  return env.MODE === 'production' ? 'live' : 'mock'
}
export function mockCloudMode() { return resolveCloudMode((import.meta.env ?? {}) as Record<string, unknown>) === 'mock' }
export function passiveCloudReadAllowed() {
  return (typeof navigator === 'undefined' || navigator.onLine !== false)
    && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
}
