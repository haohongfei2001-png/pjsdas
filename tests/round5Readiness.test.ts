import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const plan = JSON.parse(readFileSync(
  new URL('../.github/release-plan.json', import.meta.url),
  'utf8',
)) as {
  publicVersion: string
  tag: string
  releaseChannel: string
  publishOnProductionSuccess: boolean
}

const readiness = readFileSync(
  new URL('../docs/RC_1_1_0_READINESS.md', import.meta.url),
  'utf8',
)

const publishWorkflow = readFileSync(
  new URL('../.github/workflows/publish-release.yml', import.meta.url),
  'utf8',
)

describe('Round 5 RC readiness contract', () => {
  it('stages rc.1 as a disarmed prerelease', () => {
    expect(plan.publicVersion).toBe('1.1.0-rc.1')
    expect(plan.tag).toBe('v1.1.0-rc.1')
    expect(plan.releaseChannel).toBe('prerelease')
    expect(plan.publishOnProductionSuccess).toBe(false)
  })

  it('records configured platform gates without weakening the publication workflow', () => {
    expect(readiness).toContain('IMPLEMENTATION READY / PLATFORM GATES CONFIGURED / PUBLICATION DISARMED')
    expect(readiness).toContain('main.protected = true')
    expect(readiness).toContain('PJSDAS_RELEASE_ADMIN_TOKEN')
    expect(readiness).toContain('Release immutability')
    expect(publishWorkflow).toContain('Default branch $default_branch is not protected')
    expect(publishWorkflow).toContain('/immutable-releases')
    expect(publishWorkflow).toContain('--prerelease')
  })
})
