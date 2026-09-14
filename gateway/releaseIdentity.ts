import { GENERATED_RELEASE_COMMIT_SHA } from './generatedReleaseIdentity.js'

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
