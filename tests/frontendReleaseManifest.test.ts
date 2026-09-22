import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const script = join(repoRoot, 'scripts', 'write-frontend-release-manifest.mjs')
const roots: string[] = []

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('frontend release candidate manifest', () => {
  it('binds artifact digest, source commit and backend contract hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'pjsdas-frontend-manifest-'))
    roots.push(root)
    const dist = join(root, 'dist')
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>PJSDAS</title>')
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("rc")')

    const sha = '1234567890abcdef1234567890abcdef12345678'
    execFileSync(process.execPath, [script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_SHA: sha,
        PJSDAS_RELEASE_MANIFEST_DIST: dist,
        VITE_PJSDAS_CONNECTED_AUTHORITY: 'google-drive',
      },
      stdio: 'pipe',
    })

    const manifest = JSON.parse(readFileSync(join(dist, 'release-manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      schema: 'pjsdas-release-manifest',
      version: 1,
      productVersion: '1.1.0-rc.1',
      releaseChannel: 'prerelease',
      commitSha: sha,
      topology: { connectedAuthority: 'google-drive' },
      schemaCompatibility: {
        snapshotSchema: 'pjsdas-local-snapshot',
        snapshotVersion: 4,
      },
    })
    expect(manifest.frontendArtifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(manifest.mcpContractHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(manifest.migrationSetHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(manifest.schemaCompatibility.migrationSet).toContain('2026091903_controlled_audience.sql')
  })
})
