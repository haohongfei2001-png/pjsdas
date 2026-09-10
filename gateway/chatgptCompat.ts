import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const

function createCompatServer() {
  const server = new McpServer(
    { name: 'pjsdas-compat', version: '1.1.0-alpha.3' },
    {
      instructions: 'Minimal read-only compatibility probe for ChatGPT. Synthetic data only.',
    },
  )

  server.registerTool(
    'search',
    {
      title: 'Search PJSDAS demo data',
      description: 'Search synthetic PJSDAS demo records. This tool is read-only.',
      inputSchema: z.object({ query: z.string().min(1) }),
      annotations,
    },
    async ({ query }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          query,
          results: [
            { id: 'demo-opportunity-1', title: 'Example Company | AI Product Manager', source: 'synthetic' },
          ],
        }),
      }],
    }),
  )

  server.registerTool(
    'fetch',
    {
      title: 'Fetch a PJSDAS demo record',
      description: 'Fetch one synthetic PJSDAS demo record by id. This tool is read-only.',
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations,
    },
    async ({ id }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          id,
          title: 'Example Company | AI Product Manager',
          stage: 'not_applied',
          fitScore: 80,
          source: 'synthetic',
        }),
      }],
    }),
  )

  return server
}

export const chatgptCompatHandler = createMcpHandler(() => createCompatServer())
