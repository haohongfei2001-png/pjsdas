import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const consent = readFileSync(new URL('../src/aiAccess/OAuthConsentPageHeavy.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../src/aiAccess/AiAccessSettingsCard.tsx', import.meta.url), 'utf8')
const protectedResource = readFileSync(new URL('../api/oauth-protected-resource.ts', import.meta.url), 'utf8')
const serverFactory = readFileSync(new URL('../gateway/serverFactory.ts', import.meta.url), 'utf8')

describe('OAuth capability truth', () => {
  it('discloses bounded trusted ingestion whenever the authenticated MCP runtime exposes it', () => {
    expect(serverFactory).toContain("server.registerTool('ingest_discovery_run'")
    expect(serverFactory).toContain("server.registerTool('ingest_gmail_run'")
    expect(serverFactory).toContain('readOnlyHint: false')

    expect(consent).toContain('受信任的 Monitor / Gmail 摄入')
    expect(consent).toContain('不能静默修改 Decision Rules、持久偏好、拒绝决定，也不能删除数据')
    expect(consent).toContain('允许此访问')
    expect(consent).not.toContain('此授权仅用于 v1.1 的只读工具')
    expect(consent).not.toContain('允许只读访问')

    expect(settings).toContain('trusted discovery or recruiting-email intake may add only bounded, source-backed facts')
    expect(settings).toContain('changes to durable preferences, rejection decisions, or deletions still require your review')
    expect(settings).not.toContain('Direct AI access remains read-only')
  })

  it('does not advertise the protected MCP resource itself as read-only', () => {
    expect(protectedResource).toContain("resource_name: 'TodayAction job-search data with bounded trusted ingestion'")
    expect(protectedResource).not.toContain("resource_name: 'TodayAction read-only job-search data'")
  })
})
