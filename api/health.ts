import { REMOTE_GATEWAY_MODE, REMOTE_GATEWAY_VERSION } from '../gateway/remoteHttp.js'

export default {
  fetch() {
    return Response.json({
      service: 'pjsdas-mcp',
      version: REMOTE_GATEWAY_VERSION,
      mode: REMOTE_GATEWAY_MODE,
      auth: 'none',
      data: 'synthetic-demo-only',
      status: 'ok',
    })
  },
}
