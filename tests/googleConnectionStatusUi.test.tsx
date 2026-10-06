import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AiAccessSettingsCard from '../src/aiAccess/AiAccessSettingsCard.js'
const state = vi.hoisted(() => ({ error: 'GOOGLE_AUTH_EXPIRED', language: 'en', enabled: true }))
vi.mock('../src/aiAccess/AiAccessContext.js', () => ({ useAiAccess: () => ({
  statusVerified: true, busy: false,
  gmailAutomation: { googleEmail: 'fictional@example.invalid', gmailEnabled: state.enabled,
    gmailScopeGranted: true, gmailLastError: state.error, gmailLastCheckedAt: '2026-10-05T20:50:00Z', gmailLastSuccessAt: '2026-10-04T12:30:00Z',
    discoveryEnabled: true, discoveryReadiness: { profileConfigured: false, budgetState: 'approval_required' } },
}) }))
vi.mock('../src/db.js', () => ({ getAllTimelineRecords: async () => [] }))
vi.mock('../src/uiLanguage.js', () => ({ useUiLanguage: () => ({ lang: state.language }) }))

describe('Google connection status rendering', () => {
  it('makes reconnect visible while preserving attempt and complete-sync labels and unconfigured discovery', () => {
    state.error = 'GOOGLE_AUTH_EXPIRED [profile] HTTP 401'; state.enabled = true; state.language = 'en'
    const html = renderToStaticMarkup(<AiAccessSettingsCard />)
    expect(html).toContain('Reconnect Google required')
    expect(html).toContain('Review and reauthorize Gmail')
    expect(html).toContain('Last complete sync:')
    expect(html).toContain('Last attempt:')
    expect(html).not.toContain('>Connected</span>')
    expect(html).toContain('preferences')
  })
  it.each(['GOOGLE_GMAIL_SCOPE_MISSING', 'GOOGLE_ACCOUNT_MISMATCH'])('provides explicit permission/account recovery for %s', (error) => {
    state.error = error; state.enabled = true; state.language = 'en'
    const html = renderToStaticMarkup(<AiAccessSettingsCard />)
    expect(html).toContain('Review and reauthorize Gmail')
    expect(html).not.toContain('Retry pending')
  })
  it.each(['GOOGLE_DRIVE_UNAVAILABLE', 'GOOGLE_AUTH_CONFIG_INVALID'])('does not ask for new consent for %s', (error) => {
    state.error = error; state.enabled = true; state.language = 'en'
    const html = renderToStaticMarkup(<AiAccessSettingsCard />)
    expect(html).not.toContain('Review and reauthorize Gmail')
    expect(html).toContain(error === 'GOOGLE_AUTH_CONFIG_INVALID' ? 'Authorization configuration needs attention' : 'Retry pending')
  })
  it('keeps the reconnect path available even when tracking is disabled, in Chinese', () => {
    state.error = 'GOOGLE_AUTH_EXPIRED'; state.enabled = false; state.language = 'zh'
    expect(renderToStaticMarkup(<AiAccessSettingsCard />)).toContain('查看并重新授权 Gmail')
  })
})
