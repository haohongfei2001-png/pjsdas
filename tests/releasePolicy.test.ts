import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AUTHENTICATED_GATEWAY_VERSION } from '../gateway/authenticatedRemoteHttp.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
const plan = JSON.parse(readFileSync(new URL('../.github/release-plan.json', import.meta.url), 'utf8')) as {
  publicVersion: string
  tag: string
  engineeringMilestone: string
  releaseNotes: string
  publishOnProductionSuccess: boolean
}
const workflow = readFileSync(new URL('../.github/workflows/publish-release.yml', import.meta.url), 'utf8')
const policy = readFileSync(new URL('../docs/RELEASE_POLICY.md', import.meta.url), 'utf8')

describe('formal release policy', () => {
  it('maps public SemVer, package version, tag, and release notes consistently', () => {
    expect(plan.publicVersion).toBe(pkg.version)
    expect(plan.tag).toBe(`v${pkg.version}`)
    expect(plan.engineeringMilestone).toBe('v1.10')
    expect(plan.publishOnProductionSuccess).toBe(true)
    expect(existsSync(new URL(`../${plan.releaseNotes}`, import.meta.url))).toBe(true)
  })

  it('publishes only after a successful production self-test and targets that exact verified SHA', () => {
    expect(workflow).toContain('workflows: ["PJSDAS Production Self-Test"]')
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(workflow).toContain('RELEASE_SHA: ${{ github.event.workflow_run.head_sha }}')
    expect(workflow).toContain('--target "$RELEASE_SHA"')
    expect(workflow).toContain('permissions:')
    expect(workflow).toContain('contents: write')
    expect(workflow).toContain('gh release create')
    expect(workflow).toContain('refusing to move or reuse it')
  })

  it('keeps gateway runtime compatibility version independent from public product SemVer', () => {
    expect(AUTHENTICATED_GATEWAY_VERSION).toBe('1.9.0-alpha.1')
    expect(AUTHENTICATED_GATEWAY_VERSION).not.toBe(pkg.version)
    expect(policy).toContain('engineering milestones')
    expect(policy).toContain('Gateway runtime version')
    expect(policy).toContain('Git commit SHA')
  })
})
