import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function resolveReleaseMetadata(root = process.cwd()) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const mcpSource = readFileSync(resolve(root, 'gateway/mcpToolSurface.ts'), 'utf8')
  const snapshotSource = readFileSync(resolve(root, 'src/snapshot.ts'), 'utf8')
  const migrations = readdirSync(resolve(root, 'supabase/migrations'))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()

  const schema = /export const SNAPSHOT_SCHEMA = ['"]([^'"]+)['"]/.exec(snapshotSource)?.[1]
  const version = Number(/export const SNAPSHOT_VERSION = (\d+)/.exec(snapshotSource)?.[1])
  if (!schema || !Number.isInteger(version)) {
    throw new Error('Could not resolve PJSDAS snapshot compatibility from src/snapshot.ts')
  }

  return {
    productVersion: pkg.version,
    releaseChannel: String(pkg.version).includes('-') ? 'prerelease' : 'stable',
    mcpContractHash: sha256(mcpSource),
    migrationSet: migrations,
    migrationSetHash: sha256(migrations.join('\n')),
    snapshotSchema: schema,
    snapshotVersion: version,
  }
}

export function resolveCommitSha(environment = process.env) {
  const candidates = [
    environment.PJSDAS_RELEASE_COMMIT_SHA,
    environment.VERCEL_GIT_COMMIT_SHA,
    environment.GITHUB_SHA,
    environment.WORKERS_CI_COMMIT_SHA,
  ]
  for (const raw of candidates) {
    const value = raw?.trim()
    if (value && /^[0-9a-f]{7,64}$/i.test(value)) return value.toLowerCase()
  }
  return undefined
}
