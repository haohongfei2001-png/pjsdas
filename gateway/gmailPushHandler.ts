import { WorkspaceSourceError } from './workspaceSource.js'

interface PubSubEnvelope {
  message?: {
    data?: string
    messageId?: string
  }
  subscription?: string
}

interface GmailPushNotification {
  emailAddress?: string
  historyId?: string
}

export interface GmailPushHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  supabaseServiceRoleKey: string
  expectedAudience: string
  expectedServiceAccountEmail: string
  expectedSubscription: string
  deliveryMode?: 'polling' | 'push'
  executionControlsEnabled: boolean
  fetchImpl?: typeof fetch
}

function bearer(request: Request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')
  return match?.[1]?.trim() ?? ''
}

function looksLikeJwt(token: string) {
  return token.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
}

function decodeBase64Json(value: string): GmailPushNotification | undefined {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as GmailPushNotification
  } catch {
    return undefined
  }
}

function validEmail(value: string) {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

async function verifyGoogleOidc(
  token: string,
  config: GmailPushHandlerConfig,
  fetchImpl: typeof fetch,
) {
  if (!config.expectedAudience.trim() || !config.expectedServiceAccountEmail.trim() || !config.expectedSubscription.trim()) {
    throw new WorkspaceSourceError('GMAIL_PUSH_NOT_CONFIGURED', 'PJSDAS Gmail push authentication is not configured.', false)
  }

  let response: Response
  try {
    response = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' },
    })
  } catch {
    throw new WorkspaceSourceError('GMAIL_PUSH_AUTH_UNAVAILABLE', 'Google push authentication is temporarily unavailable.', true)
  }
  if (response.status === 429 || response.status >= 500) {
    throw new WorkspaceSourceError('GMAIL_PUSH_AUTH_UNAVAILABLE', 'Google push authentication is temporarily unavailable.', true)
  }
  if (!response.ok) {
    throw new WorkspaceSourceError('GMAIL_PUSH_AUTH_INVALID', 'Gmail push authentication failed.', false)
  }

  const claims = await response.json().catch(() => undefined) as {
    aud?: string
    email?: string
    email_verified?: string | boolean
    iss?: string
  } | undefined
  const issuerOk = claims?.iss === 'https://accounts.google.com' || claims?.iss === 'accounts.google.com'
  const verified = claims?.email_verified === true || claims?.email_verified === 'true'
  if (!issuerOk || !verified || claims?.aud !== config.expectedAudience || claims?.email !== config.expectedServiceAccountEmail) {
    throw new WorkspaceSourceError('GMAIL_PUSH_AUTH_INVALID', 'Gmail push authentication claims are invalid.', false)
  }
}

async function enqueueExistingWorker(
  emailAddress: string,
  historyId: string,
  config: GmailPushHandlerConfig,
  fetchImpl: typeof fetch,
) {
  if (!config.supabaseServiceRoleKey.trim()) {
    throw new WorkspaceSourceError('GMAIL_PUSH_NOT_CONFIGURED', 'PJSDAS server authorization is not configured.', false)
  }
  const baseUrl = config.supabaseUrl.replace(/\/+$/, '')
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}/rest/v1/rpc/pjsdas_enqueue_gmail_push_worker`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        apikey: config.supabasePublishableKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        target_email: emailAddress,
        notified_history_id: historyId,
      }),
    })
  } catch {
    throw new WorkspaceSourceError('GMAIL_PUSH_ENQUEUE_UNAVAILABLE', 'PJSDAS Gmail push queue is temporarily unavailable.', true)
  }
  if (!response.ok) {
    throw new WorkspaceSourceError('GMAIL_PUSH_ENQUEUE_UNAVAILABLE', `PJSDAS Gmail push queue failed (HTTP ${response.status}).`, true)
  }
  // The result is intentionally ignored. No eligible binding is an acknowledged
  // no-op; the notification contains no business fact and periodic compensation remains.
}

export function createGmailPushHandler(config: GmailPushHandlerConfig) {
  const fetchImpl = config.fetchImpl ?? fetch
  return async function handleGmailPush(request: Request) {
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } })
    }

    if ((config.deliveryMode ?? 'polling') !== 'push') {
      return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } })
    }

    if (!config.executionControlsEnabled) {
      return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } })
    }

    const token = bearer(request)
    if (!token || !looksLikeJwt(token)) {
      return new Response(null, { status: 401, headers: { 'cache-control': 'no-store' } })
    }

    try {
      await verifyGoogleOidc(token, config, fetchImpl)
      const envelope = await request.json().catch(() => undefined) as PubSubEnvelope | undefined
      if (envelope?.subscription !== config.expectedSubscription) {
        return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } })
      }
      const notification = envelope?.message?.data ? decodeBase64Json(envelope.message.data) : undefined
      const emailAddress = notification?.emailAddress?.trim().toLowerCase() ?? ''
      const historyId = notification?.historyId?.trim() ?? ''
      if (!validEmail(emailAddress) || !/^\d{1,32}$/.test(historyId)) {
        // Authenticated but malformed messages are acknowledged so Pub/Sub does
        // not retry poison input forever. No mailbox or workspace is touched.
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      }
      await enqueueExistingWorker(emailAddress, historyId, config, fetchImpl)
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    } catch (caught) {
      const error = caught instanceof WorkspaceSourceError ? caught : undefined
      if (error?.code === 'GMAIL_PUSH_AUTH_INVALID') {
        return new Response(null, { status: 401, headers: { 'cache-control': 'no-store' } })
      }
      return new Response(null, { status: error?.retryable ? 503 : 500, headers: { 'cache-control': 'no-store' } })
    }
  }
}
