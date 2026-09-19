import { describe, expect, it } from 'vitest'
import {
  audienceMode,
  canonicalApiOrigin,
  canonicalWebOrigin,
  firstPartyWebOrigins,
  legacyWebOrigins,
  publicProductionTopology,
} from '../gateway/productionTopology.js'

describe('production topology contract', () => {
  it('preserves the current GitHub Pages origin as a safe legacy default', () => {
    expect(legacyWebOrigins({})).toEqual(['https://haohongfei2001-png.github.io'])
    expect(publicProductionTopology({}).audienceMode).toBe('legacy')
  })

  it('combines canonical, legacy and explicitly allowed first-party origins without duplicates', () => {
    const env = {
      NODE_ENV: 'production',
      PJSDAS_CANONICAL_WEB_ORIGIN: 'https://pjsdas.example/',
      PJSDAS_CANONICAL_API_ORIGIN: 'https://api.pjsdas.example/',
      PJSDAS_LEGACY_WEB_ORIGINS: 'https://haohongfei2001-png.github.io,https://legacy.example',
      PJSDAS_ALLOWED_WEB_ORIGINS: 'https://preview.example,https://legacy.example/',
      PJSDAS_AUDIENCE_MODE: 'allowlist',
    }
    expect(canonicalWebOrigin(env)).toBe('https://pjsdas.example')
    expect(canonicalApiOrigin(env)).toBe('https://api.pjsdas.example')
    expect(firstPartyWebOrigins(env)).toEqual([
      'https://pjsdas.example',
      'https://haohongfei2001-png.github.io',
      'https://legacy.example',
      'https://preview.example',
    ])
    expect(audienceMode(env)).toBe('allowlist')
  })

  it('rejects insecure non-local production origins', () => {
    expect(() => canonicalWebOrigin({ PJSDAS_CANONICAL_WEB_ORIGIN: 'http://pjsdas.example' })).toThrow(/HTTPS/)
  })
})
