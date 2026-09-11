import { createAuthenticatedDriveWorkspaceSource } from '../gateway/authenticatedDriveSource.js'
import { createSupabaseIdentityResolver } from '../gateway/supabaseIdentity.js'
import { decryptSecret } from '../gateway/tokenCrypto.js'

export default {
  fetch() {
    return Response.json({
      authenticatedDriveSource: typeof createAuthenticatedDriveWorkspaceSource === 'function',
      supabaseIdentity: typeof createSupabaseIdentityResolver === 'function',
      tokenCrypto: typeof decryptSecret === 'function',
    })
  },
}
