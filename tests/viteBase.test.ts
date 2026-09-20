import { describe, expect, it } from 'vitest'
import { resolveViteBase } from '../vite.config'

describe('PJSDAS Vite deployment base', () => {
  it('keeps the legacy GitHub Pages base by default', () => {
    expect(resolveViteBase({})).toBe('/pjsdas/')
  })

  it('serves the canonical Vercel app from the origin root', () => {
    expect(resolveViteBase({ VERCEL: '1' })).toBe('/')
  })

  it('accepts an explicit absolute base override', () => {
    expect(resolveViteBase({ PJSDAS_VITE_BASE: '/preview/' })).toBe('/preview/')
  })

  it('rejects malformed base overrides', () => {
    expect(() => resolveViteBase({ PJSDAS_VITE_BASE: 'preview' })).toThrow(
      'PJSDAS_VITE_BASE must be an absolute path ending with /.',
    )
  })
})
