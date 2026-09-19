import { describe, expect, it } from 'vitest'
import { resolveProductionBaseUrls } from '../gateway/productionBaseUrls.js'

describe('production self-test backend origin normalization', () => {
  it('omits an undefined canonical API origin instead of calling trim on it', () => {
    expect(resolveProductionBaseUrls({
      canonicalApiOrigin: undefined,
      configuredOrigins: 'https://pjsdas-remote-alpha.vercel.app',
    })).toEqual(['https://pjsdas-remote-alpha.vercel.app'])
  })

  it('prefers canonical API and de-duplicates configured fallbacks', () => {
    expect(resolveProductionBaseUrls({
      canonicalApiOrigin: 'https://api.pjsdas.example/',
      configuredOrigins: 'https://pjsdas-remote-alpha.vercel.app, https://api.pjsdas.example',
    })).toEqual([
      'https://api.pjsdas.example',
      'https://pjsdas-remote-alpha.vercel.app',
    ])
  })
})
