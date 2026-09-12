import { readFileSync } from 'node:fs'
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

  it('preserves the OAuth protected-resource rewrites', () => {
    expect(config.rewrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/oauth-protected-resource',
      }),
    ]))
  })
})
