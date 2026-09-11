import { authenticatedRemoteMcpFetch } from '../gateway/authenticatedRemoteHttp'

export default {
  fetch(request: Request) {
    return authenticatedRemoteMcpFetch(request)
  },
}
