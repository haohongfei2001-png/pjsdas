import authenticatedMcpHandler from './mcp-auth.js'

/**
 * Primary PJSDAS MCP endpoint.
 *
 * v1.3 serves only the authenticated user's validated PJSDAS workspace from
 * Google Drive appDataFolder. There is no synthetic/demo fallback on this
 * endpoint. ChatGPT is challenged through OAuth before any personal data is
 * read. Job discovery remains read-first and review-only: discovered jobs can
 * enter PJSDAS only through a signed ChangeSet that the user explicitly Applys.
 */
export default authenticatedMcpHandler
