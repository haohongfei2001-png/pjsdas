import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { resolveCommitSha, resolveReleaseMetadata } from './release-metadata.mjs'

function filesUnder(root) {
  const result = []
  for (const name of readdirSync(root)) {
    if (name === 'release-manifest.json') continue
    const path = join(root, name)
    if (statSync(path).isDirectory()) result.push(...filesUnder(path))
    else result.push(path)
  }
  return result
}

function artifactDigest(dist) {
  const hash = createHash('sha256')
  const files = filesUnder(dist).sort((a, b) => relative(dist, a).localeCompare(relative(dist, b)))
  for (const path of files) {
    const name = relative(dist, path).replaceAll('\\', '/')
    const bytes = readFileSync(path)
    hash.update(name)
    hash.update('\0')
    hash.update(createHash('sha256').update(bytes).digest('hex'))
    hash.update('\n')
  }
  return `sha256:${hash.digest('hex')}`
}

const root = process.cwd()
const dist = resolve(root, 'dist')
const metadata = resolveReleaseMetadata(root)
const commitSha = resolveCommitSha(process.env)

const manifest = {
  schema: 'pjsdas-release-manifest',
  version: 1,
  productVersion: metadata.productVersion,
  releaseChannel: metadata.releaseChannel,
  commitSha: commitSha ?? null,
  frontendArtifactDigest: artifactDigest(dist),
  mcpContractHash: metadata.mcpContractHash,
  migrationSetHash: metadata.migrationSetHash,
  schemaCompatibility: {
    snapshotSchema: metadata.snapshotSchema,
    snapshotVersion: metadata.snapshotVersion,
    migrationSet: metadata.migrationSet,
  },
  topology: {
    canonicalWebOrigin: process.env.VITE_PJSDAS_CANONICAL_WEB_ORIGIN?.trim() || null,
    canonicalApiOrigin: process.env.VITE_PJSDAS_CANONICAL_API_ORIGIN?.trim() || null,
    connectedAuthority: process.env.VITE_PJSDAS_CONNECTED_AUTHORITY?.trim() || 'google-drive',
  },
}

writeFileSync(resolve(dist, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`PJSDAS frontend release manifest: ${manifest.productVersion} · ${manifest.frontendArtifactDigest}`)
