import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const raw = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
const config = JSON.parse(raw) as {
  git?: { deploymentEnabled?: Record<string, boolean> }
  rewrites?: Array<{ source?: string; destination?: string }>
}

describe('Vercel deployment policy', () => {
  it('deploys automatically from main while suppressing feature-branch preview churn', () => {
    expect(config.git?.deploymentEnabled).toEqual({
      '*': false,
      main: true,
    })
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
