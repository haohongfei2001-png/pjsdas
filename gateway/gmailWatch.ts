import { refreshGoogleAccessToken } from './googleOAuthTokens.js'
import { decryptSecret } from './tokenCrypto.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const GMAIL_WATCH_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/watch'
const TOPIC_RE = /^projects\/[A-Za-z0-9][A-Za-z0-9._:-]{3,127}\/topics\/[A-Za-z][A-Za-z0-9._~-]{2,254}$/

export interface GmailWatchResult {
  historyId: string
  expiresAt: string
  renewedAt: string
}

export interface GmailWatchOptions {
  refreshTokenCiphertext: string
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  topicName: string
  fetchImpl?: typeof fetch
  now?: () => Date
}

function validateTopicName(topicName: string) {
  const value = topicName.trim()
  if (!TOPIC_RE.test(value)) {
    throw new WorkspaceSourceError(
      'GMAIL_PUSH_NOT_CONFIGURED',
      'PJSDAS Gmail push topic is not configured correctly.',
      false,
    )
  }
  return value
}

export async function registerGmailWatch(options: GmailWatchOptions): Promise<GmailWatchResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now?.() ?? new Date()
  const topicName = validateTopicName(options.topicName)
  const refreshToken = await decryptSecret(options.refreshTokenCiphertext, options.tokenEncryptionKey)
  const accessToken = await refreshGoogleAccessToken(refreshToken, {
    clientId: options.googleClientId,
    clientSecret: options.googleClientSecret,
    fetchImpl,
  })

  let response: Response
  try {
    response = await fetchImpl(GMAIL_WATCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      // Intentionally omit label filters. UU-06 requires recruiting mail outside
      // INBOX to remain observable, while the downstream parser decides relevance.
      body: JSON.stringify({ topicName }),
    })
  } catch {
    throw new WorkspaceSourceError('GMAIL_PUSH_UNAVAILABLE', 'Gmail push registration is temporarily unavailable.', true)
  }

  if (response.status === 401) {
    throw new WorkspaceSourceError('GOOGLE_AUTH_EXPIRED', 'Google authorization is no longer valid. Reconnect Google to PJSDAS.', false)
  }
  if (response.status === 403) {
    throw new WorkspaceSourceError(
      'GMAIL_PUSH_FORBIDDEN',
      'Google rejected Gmail push registration. Verify the Pub/Sub topic and Gmail publisher permission.',
      false,
    )
  }
  if (response.status === 429 || response.status >= 500) {
    throw new WorkspaceSourceError('GMAIL_PUSH_UNAVAILABLE', `Gmail push registration is temporarily unavailable (HTTP ${response.status}).`, true)
  }
  if (!response.ok) {
    throw new WorkspaceSourceError('GMAIL_PUSH_REGISTRATION_FAILED', `Gmail push registration failed (HTTP ${response.status}).`, false)
  }

  const payload = await response.json().catch(() => undefined) as { historyId?: string; expiration?: string } | undefined
  const expirationMs = Number(payload?.expiration)
  if (!payload?.historyId || !/^\d+$/.test(payload.historyId) || !Number.isFinite(expirationMs) || expirationMs <= now.getTime()) {
    throw new WorkspaceSourceError('GMAIL_PUSH_RESPONSE_INVALID', 'Gmail push registration returned invalid watch metadata.', true)
  }

  return {
    historyId: payload.historyId,
    expiresAt: new Date(expirationMs).toISOString(),
    renewedAt: now.toISOString(),
  }
}
