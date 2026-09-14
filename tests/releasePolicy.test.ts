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
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

describe('formal release policy', () => {
  it('keeps the completed v1.0.0 mapping while leaving publication disarmed after release', () => {
    expect(plan.publicVersion).toBe(pkg.version)
    expect(plan.tag).toBe(`v${pkg.version}`)
    expect(plan.engineeringMilestone).toBe('v1.10')
    expect(plan.publishOnProductionSuccess).toBe(false)
    expect(existsSync(new URL(`../${plan.releaseNotes}`, import.meta.url))).toBe(true)
  })

  it('publishes an armed release only after a successful production self-test and targets that exact verified SHA', () => {
    expect(workflow).toContain('workflows: ["PJSDAS Production Self-Test"]')
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(workflow).toContain('RELEASE_SHA: ${{ github.event.workflow_run.head_sha }}')
    expect(workflow).toContain("publish=${plan.publishOnProductionSuccess === true ? 'true' : 'false'}")
    expect(workflow).toContain("steps.plan.outputs.publish == 'true'")
    expect(workflow).toContain('--target "$RELEASE_SHA"')
    expect(workflow).toContain('permissions:')
    expect(workflow).toContain('contents: write')
    expect(workflow).toContain('gh release create')
    expect(workflow).toContain('refusing to move or reuse it')
  })

  it('keeps gateway runtime compatibility independent and does not pretend workflow safety equals GitHub platform immutability', () => {
    expect(AUTHENTICATED_GATEWAY_VERSION).toBe('1.9.0-alpha.1')
    expect(AUTHENTICATED_GATEWAY_VERSION).not.toBe(pkg.version)
    expect(policy).toContain('engineering milestones')
    expect(policy).toContain('Gateway runtime version')
    expect(policy).toContain('Git commit SHA')
    expect(policy).toContain('GitHub platform release immutability')
    expect(policy).toContain('immutable=false')
    expect(policy).not.toContain('creates the immutable tag/release')
    expect(readme).toContain('version-pinned Git tag and GitHub Release')
    expect(readme).toContain('not GitHub-platform-immutable')
  })
})
