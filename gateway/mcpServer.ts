import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createPjsdasMcpServer } from './serverFactory'
import { createEnvWorkspaceSource } from './workspaceSource'

const source = createEnvWorkspaceSource()

void serveStdio(() => createPjsdasMcpServer(source))
console.error('PJSDAS MCP Gateway v1.1 alpha running on stdio (read-only).')
