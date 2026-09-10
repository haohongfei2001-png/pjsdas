import { remoteMcpHandler } from '../gateway/remoteHttp'

/**
 * Vercel-compatible Web Handler for the PJSDAS remote MCP alpha.
 *
 * The current public alpha intentionally serves synthetic demo data only.
 * Real user data will require authenticated Google Drive access before this
 * endpoint can be switched to a personal workspace source.
 */
export default {
  fetch(request: Request) {
    return remoteMcpHandler.fetch(request)
  },
}
