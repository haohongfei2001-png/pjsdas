import { createMcpHandler } from '@modelcontextprotocol/server'
import { createPjsdasMcpServer } from './serverFactory.js'
import { createFileWorkspaceSource } from './workspaceSource.js'

export const REMOTE_GATEWAY_MODE = 'demo' as const
export const REMOTE_GATEWAY_VERSION = '1.1.0-alpha.2' as const

const source = createFileWorkspaceSource({
  file: new URL('./fixtures/demo-workspace.json', import.meta.url),
  timezone: 'Asia/Shanghai',
  workspaceVersion: 'remote-demo-v1',
})

/**
 * Public remote MCP alpha.
 *
 * Security boundary: this handler is intentionally unauthenticated and therefore
 * MUST only serve the synthetic demo workspace. Real PJSDAS data belongs behind
 * the authenticated Google Drive workspace source planned for the next stage.
 */
export const remoteMcpHandler = createMcpHandler(
  () => createPjsdasMcpServer(source, {
    version: REMOTE_GATEWAY_VERSION,
    dataMode: REMOTE_GATEWAY_MODE,
  }),
)
