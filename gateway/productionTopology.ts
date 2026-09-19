export type PjsdasAudienceMode = 'legacy' | 'allowlist'

const DEFAULT_LEGACY_WEB_ORIGINS = ['https://haohongfei2001-png.github.io']
const DEVELOPMENT_WEB_ORIGINS = ['http://localhost:5173']

function normalizedOrigin(raw: string) {
  const value = raw.trim()
  if (!value) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid PJSDAS origin configuration: ${value}`)
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`PJSDAS production origins must use HTTPS: ${value}`)
  }
  return url.origin
}

function splitOrigins(value: string | undefined) {
  if (!value?.trim()) return []
  return value.split(',').map((item) => normalizedOrigin(item)).filter((item): item is string => Boolean(item))
}

export function canonicalWebOrigin(environment: Record<string, string | undefined> = process.env) {
  return normalizedOrigin(environment.PJSDAS_CANONICAL_WEB_ORIGIN ?? '')
}

export function canonicalApiOrigin(environment: Record<string, string | undefined> = process.env) {
  return normalizedOrigin(environment.PJSDAS_CANONICAL_API_ORIGIN ?? '')
}

export function legacyWebOrigins(environment: Record<string, string | undefined> = process.env) {
  const configured = splitOrigins(environment.PJSDAS_LEGACY_WEB_ORIGINS)
  return configured.length ? configured : [...DEFAULT_LEGACY_WEB_ORIGINS]
}

export function firstPartyWebOrigins(environment: Record<string, string | undefined> = process.env) {
  const origins = new Set<string>()
  const canonical = canonicalWebOrigin(environment)
  if (canonical) origins.add(canonical)
  for (const origin of legacyWebOrigins(environment)) origins.add(origin)
  for (const origin of splitOrigins(environment.PJSDAS_ALLOWED_WEB_ORIGINS)) origins.add(origin)
  if (environment.NODE_ENV !== 'production') {
    for (const origin of DEVELOPMENT_WEB_ORIGINS) origins.add(origin)
  }
  return [...origins]
}

export function audienceMode(environment: Record<string, string | undefined> = process.env): PjsdasAudienceMode {
  return environment.PJSDAS_AUDIENCE_MODE?.trim().toLocaleLowerCase() === 'allowlist'
    ? 'allowlist'
    : 'legacy'
}

export function publicProductionTopology(environment: Record<string, string | undefined> = process.env) {
  return {
    canonicalWebOrigin: canonicalWebOrigin(environment) ?? null,
    canonicalApiOrigin: canonicalApiOrigin(environment) ?? null,
    legacyWebOrigins: legacyWebOrigins(environment),
    audienceMode: audienceMode(environment),
  }
}
