import { createMcpHandler } from '@modelcontextprotocol/server'
import { createPjsdasMcpServer } from '../gateway/serverFactory'
import { WorkspaceSourceError } from '../gateway/workspaceSource'

export default {
  fetch() {
    return Response.json({
      createMcpHandler: typeof createMcpHandler === 'function',
      serverFactory: typeof createPjsdasMcpServer === 'function',
      workspaceError: typeof WorkspaceSourceError === 'function',
    })
  },
}
