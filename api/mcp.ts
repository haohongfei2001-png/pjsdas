import authenticatedMcpHandler from './mcp-auth.js'

/**
 * Primary PJSDAS MCP endpoint.
 *
 * v1.1 serves only the authenticated user's validated PJSDAS workspace from
 * Google Drive appDataFolder. There is no synthetic/demo fallback on this
 * endpoint. The existing ChatGPT connector can keep using /api/mcp and will be
 * challenged through OAuth before any personal data is read.
 */
export default authenticatedMcpHandler
