import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const script = join(repoRoot, 'scripts', 'write-release-identity.mjs')
const tempRoots: string[] = []

function tempOutput() {
  const root = mkdtempSync(join(tmpdir(), 'pjsdas-release-identity-'))
  tempRoots.push(root)
  return join(root, 'generatedReleaseIdentity.ts')
}

function runGenerator(output: string, environment: NodeJS.ProcessEnv) {
  execFileSync(process.execPath, [script], {
    cwd: repoRoot,
    env: {
      ...environment,
      PJSDAS_RELEASE_IDENTITY_OUTPUT: output,
    },
    stdio: 'pipe',
  })
  return readFileSync(output, 'utf8')
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe('build-embedded release identity', () => {
  it('embeds an explicit release commit without requiring runtime provider settings', () => {
    const expected = '1234567890abcdef1234567890abcdef12345678'
    const source = runGenerator(tempOutput(), {
      ...process.env,
      PJSDAS_RELEASE_COMMIT_SHA: expected.toUpperCase(),
    })
    expect(source).toContain(`GENERATED_RELEASE_COMMIT_SHA: string | undefined = "${expected}"`)
    expect(source).toContain('GENERATED_PRODUCT_VERSION = "1.1.0-rc.1"')
    expect(source).toContain('GENERATED_RELEASE_CHANNEL = "prerelease"')
    expect(source).toMatch(/GENERATED_MCP_CONTRACT_HASH = "sha256:[0-9a-f]{64}"/)
    expect(source).toMatch(/GENERATED_MIGRATION_SET_HASH = "sha256:[0-9a-f]{64}"/)
    expect(source).toContain('2026091903_controlled_audience.sql')
    expect(source).toContain('GENERATED_SNAPSHOT_SCHEMA = "pjsdas-local-snapshot"')
    expect(source).toContain('GENERATED_SNAPSHOT_VERSION = 2')
  })

  it('falls back to the checked-out git HEAD when provider Git metadata is unavailable', () => {
    const environment = { ...process.env }
    delete environment.PJSDAS_RELEASE_COMMIT_SHA
    delete environment.VERCEL_GIT_COMMIT_SHA
    delete environment.GITHUB_SHA
    delete environment.WORKERS_CI_COMMIT_SHA
    const expected = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim().toLowerCase()

    const source = runGenerator(tempOutput(), environment)
    expect(source).toContain(`GENERATED_RELEASE_COMMIT_SHA: string | undefined = "${expected}"`)
  })
})
