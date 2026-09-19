import {
  GENERATED_MCP_CONTRACT_HASH,
  GENERATED_MIGRATION_SET,
  GENERATED_MIGRATION_SET_HASH,
  GENERATED_PRODUCT_VERSION,
  GENERATED_RELEASE_CHANNEL,
  GENERATED_RELEASE_COMMIT_SHA,
  GENERATED_SNAPSHOT_SCHEMA,
  GENERATED_SNAPSHOT_VERSION,
} from './generatedReleaseIdentity.js'

export interface ReleaseIdentityEnvironment {
  PJSDAS_RELEASE_COMMIT_SHA?: string
  VERCEL_GIT_COMMIT_SHA?: string
  WORKERS_CI_COMMIT_SHA?: string
}

function normalizedSha(value: string | undefined) {
  const sha = value?.trim()
  return sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha.toLowerCase() : undefined
}

/**
 * Resolve the source commit represented by this backend deployment.
 *
 * Runtime provider metadata is preferred when available. Production builds
 * also embed the checkout commit into generatedReleaseIdentity.ts so release
 * identity does not depend on a provider dashboard setting being enabled.
 */
export function backendReleaseCommit(environment?: ReleaseIdentityEnvironment) {
  const runtimeEnvironment = environment ?? (
    typeof process !== 'undefined' ? process.env as ReleaseIdentityEnvironment : {}
  )
  return normalizedSha(runtimeEnvironment.PJSDAS_RELEASE_COMMIT_SHA)
    ?? normalizedSha(runtimeEnvironment.VERCEL_GIT_COMMIT_SHA)
    ?? normalizedSha(runtimeEnvironment.WORKERS_CI_COMMIT_SHA)
    ?? normalizedSha(GENERATED_RELEASE_COMMIT_SHA)
}


export function backendReleaseContract() {
  return {
    productVersion: GENERATED_PRODUCT_VERSION,
    releaseChannel: GENERATED_RELEASE_CHANNEL,
    mcpContractHash: GENERATED_MCP_CONTRACT_HASH,
    migrationSet: [...GENERATED_MIGRATION_SET],
    migrationSetHash: GENERATED_MIGRATION_SET_HASH,
    schemaCompatibility: {
      snapshotSchema: GENERATED_SNAPSHOT_SCHEMA,
      snapshotVersion: GENERATED_SNAPSHOT_VERSION,
    },
  }
}
