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
 * Vercel exposes VERCEL_GIT_COMMIT_SHA automatically. A provider-neutral
 * PJSDAS_RELEASE_COMMIT_SHA override is available for standby providers such
 * as Cloudflare so the release gate never has to infer deployment identity.
 */
export function backendReleaseCommit(environment?: ReleaseIdentityEnvironment) {
  const runtimeEnvironment = environment ?? (
    typeof process !== 'undefined' ? process.env as ReleaseIdentityEnvironment : {}
  )
  return normalizedSha(runtimeEnvironment.PJSDAS_RELEASE_COMMIT_SHA)
    ?? normalizedSha(runtimeEnvironment.VERCEL_GIT_COMMIT_SHA)
    ?? normalizedSha(runtimeEnvironment.WORKERS_CI_COMMIT_SHA)
}
