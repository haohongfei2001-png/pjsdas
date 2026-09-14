import { describe, expect, it } from 'vitest'
import {
  driveAccessTokenRecoveryMessage,
  missingDurableDriveAuthorizationMessage,
  signedOutCloudAccountMessage,
} from '../src/cloud/cloudClientPresentation.js'

describe('cloud client local error presentation', () => {
  it('presents missing durable Google authorization in the active language', () => {
    expect(missingDurableDriveAuthorizationMessage('zh')).toContain('持续授权')
    expect(missingDurableDriveAuthorizationMessage('en')).toContain('durable authorization')
  })

  it('presents signed-out account state in the active language', () => {
    expect(signedOutCloudAccountMessage('zh')).toContain('未登录')
    expect(signedOutCloudAccountMessage('en')).toContain('not signed in')
  })

  it('keeps HTTP status in localized access-token recovery errors', () => {
    expect(driveAccessTokenRecoveryMessage('zh', 503)).toBe('无法恢复 Google Drive 授权（HTTP 503）。')
    expect(driveAccessTokenRecoveryMessage('en', 503)).toBe('Could not restore Google Drive authorization (HTTP 503).')
  })
})
