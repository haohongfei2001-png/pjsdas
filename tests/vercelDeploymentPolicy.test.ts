import { readFileSync, readdirSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { describe, expect, it } from 'vitest'

const raw = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
const config = JSON.parse(raw) as {
  git?: { deploymentEnabled?: Record<string, boolean> }
  rewrites?: Array<{ source?: string; destination?: string }>
}

describe('Vercel deployment policy', () => {
  it('deploys automatically from main while suppressing feature-branch preview churn', () => {
    expect(config.git?.deploymentEnabled).toEqual({
      '**': false,
      main: true,
    })
  })

  // Vercel documents glob matching, default true for unmatched branches, and
  // any matching true rule winning. Node's glob matcher avoids a new dependency.
  function enabled(branch: string, rules = config.git!.deploymentEnabled!) {
    const matching = Object.entries(rules).filter(([pattern]) => matchesGlob(branch, pattern))
    return matching.length === 0 || matching.some(([, value]) => value)
  }
  it.each([['main', true], ['feature', false], ['dot/test', false], ['dot/review/test', false], ['release/v3/fix', false]])('evaluates actual branch shape %s as %s', (branch, expected) => {
    expect(enabled(String(branch))).toBe(expected)
  })
  it('captures the old single-star slash-branch escape instead of merely asserting config text', () => {
    expect(enabled('dot/test', { '*': false, main: true })).toBe(true)
    expect(enabled('dot/test')).toBe(false)
    expect(enabled('main')).toBe(true)
  })

  it('keeps direct Vercel Functions within the Hobby deployment ceiling', () => {
    const functions = readdirSync(new URL('../api/', import.meta.url))
      .filter((name) => /\.(?:ts|js)$/.test(name))
    expect(functions).toHaveLength(12)
    expect(functions).not.toContain('access.ts')
    expect(config.rewrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: '/api/access',
        destination: '/api/health-auth?mode=access',
      }),
      expect.objectContaining({
        source: '/api/gmail-push',
        destination: '/api/automation-gmail?__pjsdas_gmail_route=push',
      }),
      expect.objectContaining({
        source: '/api/automation-gmail-watch',
        destination: '/api/automation-gmail?__pjsdas_gmail_route=watch',
      }),
      expect.objectContaining({
        source: '/api/automation-ingestion-reconciliation',
        destination: '/api/automation-gmail?__pjsdas_gmail_route=ingestion_reconciliation',
      }),
    ]))
  })

  it('preserves the OAuth protected-resource rewrites', () => {
    expect(config.rewrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/oauth-protected-resource',
      }),
    ]))
  })
})
