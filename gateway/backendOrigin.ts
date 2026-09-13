export const DEFAULT_BACKEND_ORIGIN = 'https://pjsdas-remote-alpha.vercel.app'

function normalizeOrigin(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('PJSDAS backend origin must use HTTPS outside local development.')
  }
  return url.origin
}

function configuredPublicOrigin() {
  if (typeof process === 'undefined') return undefined
  const value = process.env.PJSDAS_PUBLIC_BACKEND_ORIGIN?.trim()
  return value || undefined
}

export function backendOriginFromRequest(request?: Request, explicitOrigin?: string) {
  const configured = explicitOrigin?.trim() || configuredPublicOrigin()
  if (configured) return normalizeOrigin(configured)
  if (request) return normalizeOrigin(new URL(request.url).origin)
  return DEFAULT_BACKEND_ORIGIN
}

export function backendUrl(path: string, request?: Request, explicitOrigin?: string) {
  const origin = backendOriginFromRequest(request, explicitOrigin)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${origin}${normalizedPath}`
}
