import { encryptSecret } from './tokenCrypto.js'
import type { GoogleOAuthClientConfig } from './googleOAuthTokens.js'

export type GoogleRefreshLifecycle = Pick<GoogleOAuthClientConfig, 'onRefreshTokenRotated' | 'onReconnectRequired' | 'signal'>

/** Closure captures one encrypted generation. A stale worker may neither replace
 * a newer reconnect nor mark it expired. The store must implement compare-and-set. */
export function googleRefreshLifecycle(tokenEncryptionKey: string,
  persist: (patch: { nextCiphertext?: string; reconnectRequired?: boolean }) => Promise<unknown>,
): GoogleRefreshLifecycle {
  return {
    onRefreshTokenRotated: async (refreshToken) => {
      const nextCiphertext = await encryptSecret(refreshToken, tokenEncryptionKey)
      await persist({ nextCiphertext })
    },
    onReconnectRequired: async () => { await persist({ reconnectRequired: true }) },
  }
}

export function automationGoogleRefreshLifecycle(tokenEncryptionKey: string,
  binding: { userId: string; refreshTokenCiphertext: string },
  store: { updateGoogleRefreshState: (userId: string, expectedCiphertext: string, patch: { nextCiphertext?: string; reconnectRequired?: boolean }, executionToken?: string) => Promise<void> },
  executionToken?: string,
): GoogleRefreshLifecycle {
  return googleRefreshLifecycle(tokenEncryptionKey, async (patch) => {
    await store.updateGoogleRefreshState(binding.userId, binding.refreshTokenCiphertext, patch, executionToken)
    if (patch.nextCiphertext) binding.refreshTokenCiphertext = patch.nextCiphertext
  })
}
