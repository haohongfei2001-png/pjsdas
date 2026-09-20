import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
  rewrites?: Array<{ source: string; destination: string }>
}
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts?: Record<string, string>
}
const fallback = readFileSync(new URL('../scripts/write-spa-fallback.mjs', import.meta.url), 'utf8')

describe('UU-04 semantic route hosting', () => {
  it('rewrites every frozen semantic UI route to the Vercel SPA entry without intercepting APIs', () => {
    const routes = new Map((vercel.rewrites ?? []).map((item) => [item.source, item.destination]))
    for (const route of ['/today', '/today/agenda', '/opportunities', '/opportunities/:id', '/capture', '/decisions', '/settings', '/history']) {
      expect(routes.get(route)).toBe('/')
    }
    expect(routes.get('/api/access')).toContain('/api/')
    expect([...routes.keys()]).not.toContain('/:path*')
  })

  it('generates a GitHub Pages 404 fallback before hashing the frontend artifact', () => {
    expect(pkg.scripts?.postbuild).toBe('node scripts/write-spa-fallback.mjs && node scripts/write-frontend-release-manifest.mjs')
    expect(fallback).toContain("path.join(dist, 'index.html')")
    expect(fallback).toContain("path.join(dist, '404.html')")
    expect(fallback).toContain('copyFile(source, target)')
  })
})
