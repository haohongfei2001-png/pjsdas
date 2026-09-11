import { createAuthenticatedDriveWorkspaceSource } from '../gateway/authenticatedDriveSource'
import { createSupabaseIdentityResolver } from '../gateway/supabaseIdentity'
import { decryptSecret } from '../gateway/tokenCrypto'

export default {
  fetch() {
    return Response.json({
      authenticatedDriveSource: typeof createAuthenticatedDriveWorkspaceSource === 'function',
      supabaseIdentity: typeof createSupabaseIdentityResolver === 'function',
      tokenCrypto: typeof decryptSecret === 'function',
    })
  },
}
