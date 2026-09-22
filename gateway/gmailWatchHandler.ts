import { createAutomationConnectionStore } from './automationConnectionStore.js'
import { registerGmailWatch } from './gmailWatch.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface GmailWatchHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  topicName: string
  deliveryMode?: 'polling' | 'push'
  fetchImpl?: typeof fetch
  registerGmailWatchImpl?: typeof registerGmailWatch
  now?: () => Date
}

function bearer(request: Request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')
  return match?.[1]?.trim() ?? ''
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  })
}

function compactCode(caught: unknown) {
  return caught instanceof WorkspaceSourceError ? caught.code : 'GMAIL_PUSH_REGISTRATION_FAILED'
}

export function createGmailWatchHandler(config: GmailWatchHandlerConfig) {
  return async function handleGmailWatch(request: Request) {
    if (request.method !== 'POST') {
      return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' })
    }
    if ((config.deliveryMode ?? 'polling') !== 'push') {
      return json(503, { code: 'GMAIL_PUSH_DORMANT', message: 'Gmail Push is dormant in polling delivery mode.' })
    }
    const workerToken = bearer(request)
    if (!workerToken) {
      return json(401, { code: 'AUTOMATION_AUTH_REQUIRED', message: 'PJSDAS automation authorization is required.' })
    }

    const store = createAutomationConnectionStore({
      supabaseUrl: config.supabaseUrl,
      supabasePublishableKey: config.supabasePublishableKey,
      workerToken,
      fetchImpl: config.fetchImpl,
    })
    try {
      const bindings = (await store.listEnabledGmailBindings())
        .filter((binding) => binding.gmailIntakeConsentVersion === 'uu06-v1')
      let renewedUsers = 0
      let failedUsers = 0
      for (const binding of bindings) {
        try {
          const watch = await (config.registerGmailWatchImpl ?? registerGmailWatch)({
            refreshTokenCiphertext: binding.refreshTokenCiphertext,
            tokenEncryptionKey: config.tokenEncryptionKey,
            googleClientId: config.googleClientId,
            googleClientSecret: config.googleClientSecret,
            topicName: config.topicName,
            fetchImpl: config.fetchImpl,
            now: config.now,
          })
          await store.updateGmailWatchState(binding.userId, {
            historyId: watch.historyId,
            expiresAt: watch.expiresAt,
            renewedAt: watch.renewedAt,
            lastError: null,
          })
          renewedUsers += 1
        } catch (caught) {
          failedUsers += 1
          try {
            await store.updateGmailWatchState(binding.userId, { lastError: compactCode(caught) })
          } catch {
            // Watch failure is reported below; compensation polling remains authoritative.
          }
        }
      }
      return json(failedUsers ? 207 : 200, {
        eligibleUsers: bindings.length,
        renewedUsers,
        failedUsers,
      })
    } catch (caught) {
      const error = caught instanceof WorkspaceSourceError ? caught : undefined
      return json(
        error?.code === 'AUTOMATION_AUTH_REQUIRED' ? 401 : 503,
        { code: error?.code ?? 'GMAIL_WATCH_RENEWAL_FAILED', retryable: error?.retryable ?? true },
      )
    }
  }
}
