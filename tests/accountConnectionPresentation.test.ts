import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ ai: {} as Record<string, unknown>, cloud: {} as Record<string, unknown> }))
vi.mock('../src/aiAccess/AiAccessContext.js', () => ({ useAiAccess: () => fixture.ai }))
vi.mock('../src/cloud/CloudContext.js', () => ({ useCloud: () => fixture.cloud }))
vi.mock('../src/cloud/connectedWorkspaceRepository.js', () => ({ connectedWorkspaceAuthorityEnabled: () => true }))
vi.mock('../src/uiLanguage.js', () => ({ useUiLanguage: () => ({ lang: 'zh' }) }))
vi.mock('../src/db.js', () => ({ getAllTimelineRecords: async () => [] }))
import CloudSettingsCard from '../src/cloud/CloudSettingsCardHeavy.js'

const render = () => renderToStaticMarkup(createElement(CloudSettingsCard))
const account = () => render().split('</section>')[0]!
beforeEach(() => {
  fixture.ai = { busy: false, message: '', error: '', errorSource: 'status', statusVerified: true, gmailAutomation: { googleEmail: 'synthetic@example.test', gmailEnabled: false, discoveryEnabled: false } }
  fixture.cloud = { session: { user: { id: 'synthetic-account', email: 'synthetic@example.test' } }, device: { autoSync: true }, checkpoint: {} }
})

describe('account connection owns the shared Google UI', () => {
  it('keeps one account panel and the original explicit Google repair and permission disclosures', () => {
    const html = account()
    expect(html).toContain('账号与跨设备数据')
    expect(render()).not.toContain('settings-workspace-heading')
    expect(html).toContain('重新连接 Google')
    expect(html).toContain('基本身份信息和应用专用的 Drive 文件权限')
    expect(html).toContain('邮件跟踪和岗位发现仍需在下方分别启用')
    expect(html).toContain('每项来源都能单独关闭')
  })
  it.each(['status', 'workspace'])('retains %s errors with original details at the account', errorSource => {
    fixture.ai.errorSource = errorSource; fixture.ai.error = 'SYNTHETIC_EXACT_ERROR'
    const html = account()
    expect(html).toContain('SYNTHETIC_EXACT_ERROR')
    expect(html).toContain('错误详情')
  })
  it.each(['gmail', 'discovery'])('leaves %s operation errors with their own source', errorSource => {
    fixture.ai.errorSource = errorSource; fixture.ai.error = 'SYNTHETIC_SOURCE_ERROR'
    expect(account()).not.toContain('SYNTHETIC_SOURCE_ERROR')
    expect(render()).toContain('SYNTHETIC_SOURCE_ERROR')
  })
  it('does not infer a Google connection from a session or missing response', () => {
    fixture.ai.gmailAutomation = null
    expect(account()).toContain('连接待核对')
    expect(account()).not.toContain('cloud-state online')
  })
  it('keeps signed-out users on the normal login entry without a duplicate connect flow', () => {
    fixture.cloud.session = null
    const html = account()
    expect(html).toContain('使用 Google 登录')
    expect(html).not.toContain('重新连接 Google')
    expect(html).not.toContain('查看连接修复')
    expect(html).not.toContain('重新核对连接')
  })
})
