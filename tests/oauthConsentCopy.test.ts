import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const source = readFileSync(new URL('../src/aiAccess/OAuthConsentPageHeavy.tsx', import.meta.url), 'utf8')
describe('OAuth consent matches the current bounded core capability', () => {
 it('discloses explicit current-account audited writes before the allow button', () => {
  for (const text of ['当前账号', '明确给出的指令', '新增岗位', '记录投递与招聘进展', '截止时间和行动状态', '修正有依据的事实', '撤销支持恢复的操作', '幂等、审计记账与工作区版本冲突保护']) {
   expect(source).toContain(text)
   expect(source.indexOf(text)).toBeLessThan(source.indexOf("'允许此访问'"))
  }
  expect(source).not.toContain('除此之外的修改仍必须通过可审阅的 ChangeSet')
 })
 it('keeps source ingestion, expanded management and external/security boundaries explicit', () => {
  for (const text of ['另外需要来源级授权', '不包含扩展 workspace.manage 权限', '不允许永久删除数据', '修改账号安全设置', '向外部投递、发送消息、接受 Offer', '目标不明确时需要先澄清']) expect(source).toContain(text)
 })
 it('retains ordinary provider approval and denial, without capability grant persistence', () => {
  expect(source).toContain('本页确认当前账号的身份连接和下方列出的登录权限')
  expect(source).toContain('消费级业务管理需要连接后另行明确授权')
  expect(source).toContain('本页不会授予这项权限')
  expect(source).toContain('未授权或撤权后，客户端不能通过旧版基础工具继续访问消费级业务数据')
  expect(source).toContain('仅对已开放旧版基础工具的既有账号：')
  expect(source.indexOf('消费级业务管理需要连接后另行明确授权')).toBeLessThan(source.indexOf('仅对已开放旧版基础工具的既有账号：'))
  expect(source).toContain('pjsdasSupabase.auth.oauth.approveAuthorization(authorizationId)')
  expect(source).toContain('pjsdasSupabase.auth.oauth.denyAuthorization(authorizationId)')
  expect(source).not.toContain('pjsdas_business_management_grants')
 })
})
