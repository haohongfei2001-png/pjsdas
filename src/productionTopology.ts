export type BrowserOriginRole = 'local-development' | 'canonical' | 'legacy' | 'unrecognized'

function normalize(raw: string | undefined) {
  if (!raw?.trim()) return undefined
  try {
    return new URL(raw.trim()).origin
  } catch {
    return undefined
  }
}

function split(value: string | undefined) {
  return (value ?? '').split(',').map((item) => normalize(item)).filter((item): item is string => Boolean(item))
}

export function readBrowserProductionTopology() {
  const env = import.meta.env as Record<string, string | undefined>
  const canonicalWebOrigin = normalize(env.VITE_PJSDAS_CANONICAL_WEB_ORIGIN)
  const canonicalApiOrigin = normalize(env.VITE_PJSDAS_CANONICAL_API_ORIGIN)
  const legacyWebOrigins = split(env.VITE_PJSDAS_LEGACY_WEB_ORIGINS)
  if (!legacyWebOrigins.length) legacyWebOrigins.push('https://haohongfei2001-png.github.io')
  return {
    canonicalWebOrigin,
    canonicalApiOrigin,
    legacyWebOrigins: [...new Set(legacyWebOrigins)],
  }
}

export function currentBrowserOriginRole(): BrowserOriginRole {
  if (typeof window === 'undefined') return 'unrecognized'
  const current = window.location.origin
  if (current === 'http://localhost:5173' || current === 'http://127.0.0.1:5173') return 'local-development'
  const topology = readBrowserProductionTopology()
  if (topology.canonicalWebOrigin && current === topology.canonicalWebOrigin) return 'canonical'
  if (topology.legacyWebOrigins.includes(current)) return 'legacy'
  return 'unrecognized'
}

export function originTransitionState() {
  const topology = readBrowserProductionTopology()
  const role = currentBrowserOriginRole()
  return {
    ...topology,
    role,
    transitionRequired: Boolean(topology.canonicalWebOrigin && role === 'legacy'),
  }
}
