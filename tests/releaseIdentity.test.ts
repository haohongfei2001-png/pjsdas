import { describe, expect, it } from 'vitest'
import { backendReleaseCommit } from '../gateway/releaseIdentity.js'

const VERCEL_SHA = '1234567890abcdef1234567890abcdef12345678'
const OVERRIDE_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const WORKERS_SHA = 'fedcba0987654321fedcba0987654321fedcba09'

describe('backend release identity', () => {
  it('uses an explicit provider-neutral release SHA before provider metadata', () => {
    expect(backendReleaseCommit({
      PJSDAS_RELEASE_COMMIT_SHA: OVERRIDE_SHA.toUpperCase(),
      VERCEL_GIT_COMMIT_SHA: VERCEL_SHA,
      WORKERS_CI_COMMIT_SHA: WORKERS_SHA,
    })).toBe(OVERRIDE_SHA)
  })

  it('uses Vercel git metadata without requiring extra project secrets', () => {
    expect(backendReleaseCommit({ VERCEL_GIT_COMMIT_SHA: VERCEL_SHA })).toBe(VERCEL_SHA)
  })

  it('can consume Workers build metadata when it is explicitly available to the runtime', () => {
    expect(backendReleaseCommit({ WORKERS_CI_COMMIT_SHA: WORKERS_SHA })).toBe(WORKERS_SHA)
  })

  it('fails closed to undefined for missing or malformed deployment identity', () => {
    expect(backendReleaseCommit({})).toBeUndefined()
    expect(backendReleaseCommit({ VERCEL_GIT_COMMIT_SHA: 'not-a-sha' })).toBeUndefined()
  })
})
