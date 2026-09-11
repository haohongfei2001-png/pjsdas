import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createPjsdasMcpServer } from './serverFactory.js'
import { createEnvWorkspaceSource } from './workspaceSource.js'

const source = createEnvWorkspaceSource()

void serveStdio(() => createPjsdasMcpServer(source))
console.error('PJSDAS MCP Gateway v1.1 alpha running on stdio (read-only).')
