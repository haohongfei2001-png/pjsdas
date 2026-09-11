import { createDriveWorkspaceSource } from './driveWorkspaceSource'
import { createGoogleConnectionStore } from './googleConnectionStore'
import { refreshGoogleAccessToken } from './googleOAuthTokens'
import { createSupabaseIdentityResolver } from './supabaseIdentity'
import { decryptSecret } from './tokenCrypto'
import type { WorkspaceSource } from './workspaceSource'

export interface AuthenticatedDriveSourceOptions {
  supabaseUrl: string
  supabasePublishableKey: string
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  fetchImpl?: typeof fetch
  timezone?: string
  defaultAvailableMinutes?: number
}

export async function createAuthenticatedDriveWorkspaceSource(
  request: Request,
  options: AuthenticatedDriveSourceOptions,
): Promise<WorkspaceSource> {
  const fetchImpl = options.fetchImpl ?? fetch
  const resolveIdentity = createSupabaseIdentityResolver({
    supabaseUrl: options.supabaseUrl,
    publishableKey: options.supabasePublishableKey,
    fetchImpl,
  })
  const connections = createGoogleConnectionStore({
    supabaseUrl: options.supabaseUrl,
    publishableKey: options.supabasePublishableKey,
    fetchImpl,
  })

  const { identity, accessToken: pjsdasAccessToken } = await resolveIdentity(request)
  const binding = await connections.readForUser(identity.userId, pjsdasAccessToken)
  const refreshToken = await decryptSecret(binding.refreshTokenCiphertext, options.tokenEncryptionKey)
  const googleAccessToken = await refreshGoogleAccessToken(refreshToken, {
    clientId: options.googleClientId,
    clientSecret: options.googleClientSecret,
    fetchImpl,
  })

  return createDriveWorkspaceSource({
    getAccessToken: () => googleAccessToken,
    fetchImpl,
    timezone: options.timezone,
    defaultAvailableMinutes: options.defaultAvailableMinutes,
  })
}
