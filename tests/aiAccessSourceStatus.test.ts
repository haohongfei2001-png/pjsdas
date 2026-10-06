import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ ai: {} as Record<string, unknown> }))
vi.mock('../src/aiAccess/AiAccessContext.js', () => ({ useAiAccess: () => fixture.ai }))
vi.mock('../src/uiLanguage.js', () => ({ useUiLanguage: () => ({ lang: 'zh' }) }))
vi.mock('../src/db.js', () => ({ getAllTimelineRecords: async () => [] }))
import AiAccessSettingsCard from '../src/aiAccess/AiAccessSettingsCard.js'

const render = () => renderToStaticMarkup(createElement(AiAccessSettingsCard))
const section = (html: string, id: string) => html.split(`aria-labelledby="settings-${id}-heading"`)[1]!.split('</section>')[0]!
beforeEach(() => { fixture.ai = { busy: false, message: '', error: '', errorSource: 'status', statusVerified: true, gmailAutomation: null } })

describe('background-source status provenance', () => {
  it('keeps unknown source status and removes the duplicate workspace panel', () => {
    const html = render()
    expect(html).not.toContain('settings-workspace-heading')
    expect(section(html, 'gmail')).toContain('传输与对账：状态待核对')
    expect(section(html, 'gmail')).not.toContain('传输与对账：已关闭')
  })
  it('keeps last known enabled values but marks failed refresh badges unverified', () => {
    fixture.ai.gmailAutomation = { googleEmail: 'synthetic@example.test', gmailEnabled: true, discoveryEnabled: true }
    fixture.ai.statusVerified = false
    fixture.ai.error = 'SYNTHETIC_STATUS_UNAVAILABLE'
    const html = render()
    for (const id of ['discovery', 'gmail']) {
      expect(section(html, id)).toContain('状态待核对')
      expect(section(html, id)).not.toContain('cloud-state online')
    }
  })
  it.each([false,true])('does not label configured=%s as actively searching without its own budget', configured => {
    fixture.ai.gmailAutomation = { gmailEnabled: true, discoveryEnabled: true, discoveryLastCheckedAt: '2026-10-02T17:15:00Z', discoveryReadiness: { profileConfigured: configured, budgetState: 'approval_required' } }
    const discovery = section(render(), 'discovery')
    expect(discovery).toContain(configured ? '待批准 TA 搜索预算' : '待配置发现偏好')
    expect(discovery).not.toContain('cloud-state online')
    expect(discovery).not.toContain('已启用</span>')
    expect(discovery).toContain('定时检查不代表已搜索')
  })
  it('retains last known enabled state but does not verify a failed mutation response', () => {
    fixture.ai.gmailAutomation = { googleEmail: 'synthetic@example.test', gmailEnabled: true, discoveryEnabled: true }
    fixture.ai.statusVerified = false; fixture.ai.errorSource = 'gmail'; fixture.ai.error = 'SYNTHETIC_UNCERTAIN_WRITE'
    const gmail = section(render(), 'gmail')
    expect(gmail).toContain('状态待核对')
    expect(gmail).toContain('关闭自动跟踪')
    expect(gmail).toContain('SYNTHETIC_UNCERTAIN_WRITE')
    expect(gmail).not.toContain('传输与对账：已关闭')
  })
  it('distinguishes verified disconnected from a missing response', () => {
    fixture.ai.gmailAutomation = { googleEmail: null, gmailEnabled: false, discoveryEnabled: false }
    expect(section(render(), 'gmail')).toContain('未启用</span>')
  })
  it('keeps a general refresh error outside every source operation', () => {
    fixture.ai.error = 'SYNTHETIC_STATUS_UNAVAILABLE'
    const html = render()
    expect(html).not.toContain('SYNTHETIC_STATUS_UNAVAILABLE')
    for (const id of ['discovery', 'gmail']) expect(section(html, id)).not.toContain('SYNTHETIC_STATUS_UNAVAILABLE')
  })
  it.each(['workspace', 'discovery', 'gmail'])('shows a failed %s operation only at its source', source => {
    fixture.ai.error = 'SYNTHETIC_ACTION_FAILURE'; fixture.ai.errorSource = source
    const html = render()
    for (const id of ['discovery', 'gmail']) {
      expect(section(html, id).includes('SYNTHETIC_ACTION_FAILURE')).toBe(id === source)
    }
  })
})
