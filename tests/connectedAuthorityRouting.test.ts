import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

const mcp = read('gateway/authenticatedRemoteHttp.ts')
const gmail = read('gateway/gmailAutomation.ts')
const discovery = read('gateway/discoveryAutomationWorker.ts')
const web = read('src/cloud/cloudRepository.ts')
const connected = read('src/cloud/connectedWorkspaceRepository.ts')

describe('connected authority activation is all-or-nothing by contract', () => {
  it('routes every durable writer through the same transactional authority flag', () => {
    for (const source of [mcp, gmail, discovery]) {
      expect(source).toContain("PJSDAS_CONNECTED_AUTHORITY")
      expect(source).toContain("=== 'transactional'")
      expect(source).toContain('createTransactionalWorkspaceSource')
    }
    expect(web).toContain('connectedWorkspaceAuthorityEnabled()')
    expect(web).toContain('fetchConnectedRemoteWorkspace')
    expect(web).toContain('updateConnectedRemoteWorkspace')
  })

  it('does not silently bootstrap a missing connected workspace during normal sync', () => {
    expect(connected).toContain('createConnectedRemoteWorkspace')
    expect(connected).toContain('WORKSPACE_MIGRATION_REQUIRED')
    expect(connected).toContain('bootstrapConnectedWorkspace')
    expect(connected).toContain('confirmMigration: true')
  })
})
