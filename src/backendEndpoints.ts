const DEFAULT_BACKEND_ORIGINS = ['https://pjsdas-remote-alpha.vercel.app']
const HEALTH_TIMEOUT_MS = 2500

let activeOrigin: string | undefined

function normalizeOrigin(value: string) {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('PJSDAS backend origin must use HTTPS outside local development.')
  }
  return url.origin
}

export function readBackendOrigins() {
  const env = import.meta.env as Record<string, string | undefined>
  const raw = (env.VITE_PJSDAS_BACKEND_ORIGINS ?? env.VITE_PJSDAS_BACKEND_ORIGIN ?? '').trim()
  const values = raw ? raw.split(',') : DEFAULT_BACKEND_ORIGINS
  const unique = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    unique.add(normalizeOrigin(trimmed))
  }
  return unique.size ? [...unique] : [...DEFAULT_BACKEND_ORIGINS]
}

export function expectedBackendMode() {
  const env = import.meta.env as Record<string, string | undefined>
  return env.VITE_PJSDAS_CONNECTED_AUTHORITY?.trim() === 'transactional'
    ? { authority: 'transactional', mode: 'transactional-connected' }
    : { authority: 'google-drive', mode: 'google-drive-trusted-ingestion' }
}

async function healthy(origin: string, fetchImpl: typeof fetch) {
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${origin}/api/health`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return false
    const body = await response.json().catch(() => undefined) as {
      status?: string
      version?: string
      mode?: string
      workspaceAuthority?: string
      capabilities?: { deploymentPortability?: boolean }
    } | undefined
    const expected = expectedBackendMode()
    return body?.status === 'ok'
      && body.version === '1.9.0-alpha.1'
      && body.mode === expected.mode
      && body.workspaceAuthority === expected.authority
      && body.capabilities?.deploymentPortability === true
  } catch {
    return false
  } finally {
    globalThis.clearTimeout(timer)
  }
}

export async function resolveBackendOrigin(fetchImpl: typeof fetch = fetch) {
  const origins = readBackendOrigins()
  if (activeOrigin && origins.includes(activeOrigin)) return activeOrigin

  for (const origin of origins) {
    if (await healthy(origin, fetchImpl)) {
      activeOrigin = origin
      return origin
    }
  }

  throw new Error('PJSDAS 后端当前不可用。系统没有找到可用的主后端或备用后端。')
}

export async function fetchBackend(path: string, init?: RequestInit, fetchImpl: typeof fetch = fetch) {
  const origin = await resolveBackendOrigin(fetchImpl)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  try {
    const response = await fetchImpl(`${origin}${normalizedPath}`, init)
    if (response.status === 429 || response.status >= 500) activeOrigin = undefined
    return response
  } catch (caught) {
    activeOrigin = undefined
    throw caught
  }
}

export function resetBackendSelection() {
  activeOrigin = undefined
}
