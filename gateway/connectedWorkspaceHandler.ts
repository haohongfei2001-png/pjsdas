import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { hashMutationPayload } from './mutationKernel.js'
import { createAuthoritativeCommandExecutor } from './authoritativeCommands.js'
import { diffCommandObjects, readModelInvalidation } from './commandObjects.js'
import { createSupabaseIdentityResolver } from './supabaseIdentity.js'
import { createTransactionalWorkspaceStore } from './transactionalWorkspaceStore.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface ConnectedWorkspaceHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  serviceRoleKey: string
  allowedOrigins: string[]
  fetchImpl?: typeof fetch
  authorizeIdentity?: (identity: import('./supabaseIdentity.js').PjsdasIdentity) => Promise<unknown>
}

function corsHeaders(origin: string | null, allowedOrigins: string[]) {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    vary: 'Origin',
  })
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('access-control-allow-origin', origin)
    headers.set('access-control-allow-headers', 'authorization, content-type')
    headers.set('access-control-allow-methods', 'GET, POST, OPTIONS')
  }
  return headers
}

function json(status: number, body: unknown, origin: string | null, allowedOrigins: string[]) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin, allowedOrigins) })
}

function safeError(caught: unknown) {
  if (caught instanceof WorkspaceSourceError) return caught
  return new WorkspaceSourceError(
    'CONNECTED_WORKSPACE_FAILED',
    caught instanceof Error ? caught.message : 'TodayAction connected workspace request failed.',
    false,
  )
}

function parseBody<T>(raw: unknown): T {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkspaceSourceError('INVALID_ARGUMENT', 'TodayAction connected workspace request body is invalid.', false)
  }
  return raw as T
}

export function createConnectedWorkspaceHandler(config: ConnectedWorkspaceHandlerConfig) {
  const fetchImpl = config.fetchImpl ?? fetch
  const resolveIdentity = createSupabaseIdentityResolver({
    supabaseUrl: config.supabaseUrl,
    publishableKey: config.supabasePublishableKey,
    fetchImpl,
  })
  return async function handleConnectedWorkspace(request: Request) {
    const origin = request.headers.get('origin')
    if (request.method === 'OPTIONS') {
      const allowed = Boolean(origin && config.allowedOrigins.includes(origin))
      return new Response(null, {
        status: allowed ? 204 : 403,
        headers: corsHeaders(origin, config.allowedOrigins),
      })
    }

    if (!origin || !config.allowedOrigins.includes(origin)) {
      return json(403, {
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Connected workspace access is available only to an approved first-party TodayAction browser origin.',
        retryable: false,
      }, origin, config.allowedOrigins)
    }

    try {
      const { identity } = await resolveIdentity(request)
      await config.authorizeIdentity?.(identity)
      if (identity.oauthClientId) {
        throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Delegated OAuth clients cannot call the first-party connected workspace endpoint.', false)
      }
      const store = createTransactionalWorkspaceStore({
        supabaseUrl: config.supabaseUrl,
        serviceRoleKey: config.serviceRoleKey,
        fetchImpl,
      })
      const commands = createAuthoritativeCommandExecutor({
        supabaseUrl: config.supabaseUrl,
        serviceRoleKey: config.serviceRoleKey,
        fetchImpl,
      })
      const principal = { kind: 'first_party_web' as const, userId: identity.userId }

      const readWorkspace = async () => {
        const workspace = await store.readForUser(identity.userId)
        if (!workspace) {
          throw new WorkspaceSourceError(
            'WORKSPACE_MIGRATION_REQUIRED',
            'This account has not explicitly migrated a workspace to connected mode.',
            false,
          )
        }
        return json(200, {
          workspaceId: workspace.workspaceId,
          workspaceVersion: `txn:${workspace.revision}`,
          revision: workspace.revision,
          schemaVersion: workspace.schemaVersion,
          snapshot: workspace.snapshot,
        }, origin, config.allowedOrigins)
      }

      if (request.method === 'GET') return readWorkspace()

      if (request.method !== 'POST') {
        return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET, POST, or OPTIONS.' }, origin, config.allowedOrigins)
      }

      const body = parseBody<{
        action?: string
        confirmMigration?: boolean
        snapshot?: unknown
        sourceFingerprint?: string
        migratedFrom?: string
        commandId?: string
        targetCommandId?: string
        expectedRevision?: number
        baseRevision?: number
        command?: unknown
        snapshotPurpose?: 'migration_recovery'
      }>(await request.json().catch(() => undefined))

      if (body.action === 'read') return readWorkspace()

      if (body.action === 'bootstrap') {
        if (body.confirmMigration !== true) {
          throw new WorkspaceSourceError('CONFIRMATION_REQUIRED', 'Connected-mode migration requires explicit confirmation.', false)
        }
        validateSnapshot(body.snapshot)
        const snapshot = upgradeSnapshotToLatest(body.snapshot as PJSDASSnapshot)
        const computedFingerprint = await fingerprintWorkspace(snapshot)
        if (body.sourceFingerprint && body.sourceFingerprint !== computedFingerprint) {
          throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Migration fingerprint does not match the supplied snapshot.', false)
        }
        const migratedFrom = body.migratedFrom?.trim() || 'explicit-first-party-migration'
        const workspace = await store.bootstrapForUser({
          userId: identity.userId,
          snapshot,
          schemaVersion: snapshot.version,
          sourceFingerprint: computedFingerprint,
          migratedFrom,
        })
        const resultingFingerprint = await fingerprintWorkspace(workspace.snapshot)
        if (resultingFingerprint !== computedFingerprint) {
          throw new WorkspaceSourceError(
            'WORKSPACE_CONFLICT',
            'A different connected workspace already exists for this account. TodayAction will not overwrite it during migration.',
            false,
          )
        }
        return json(200, {
          outcome: 'MIGRATED_OR_ALREADY_MATCHED',
          workspaceId: workspace.workspaceId,
          workspaceVersion: `txn:${workspace.revision}`,
          revision: workspace.revision,
          schemaVersion: workspace.schemaVersion,
          snapshot: workspace.snapshot,
        }, origin, config.allowedOrigins)
      }

      if (body.action === 'command') {
        const result = await commands.execute(principal, {
          commandId: body.commandId,
          baseRevision: body.baseRevision,
          command: body.command,
        })
        return json(result.outcome === 'CONFLICT' ? 409 : 200, {
          ...result,
          workspaceVersion: `txn:${result.revision}`,
          schemaVersion: result.snapshot.version,
        }, origin, config.allowedOrigins)
      }

      if (body.action === 'receipt') {
        if (!body.commandId?.trim()) {
          throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Receipt lookup requires commandId.', false)
        }
        const result = await commands.lookup(principal, body.commandId)
        return json(200, {
          ...result,
          workspaceVersion: `txn:${result.revision}`,
          schemaVersion: result.snapshot.version,
        }, origin, config.allowedOrigins)
      }

      if (body.action === 'undo') {
        const result = await commands.undo(principal, {
          commandId: body.commandId,
          targetCommandId: body.targetCommandId,
        })
        return json(result.outcome === 'CONFLICT' ? 409 : 200, {
          ...result,
          workspaceVersion: `txn:${result.revision}`,
          schemaVersion: result.snapshot.version,
        }, origin, config.allowedOrigins)
      }

      if (body.action === 'commit') {
        if (body.snapshotPurpose !== 'migration_recovery') {
          throw new WorkspaceSourceError(
            'SNAPSHOT_COMPATIBILITY_REQUIRED',
            'Whole-snapshot connected writes require an explicit migration or recovery flow.',
            false,
          )
        }
        if (!body.commandId?.trim() || !Number.isInteger(body.expectedRevision)) {
          throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Connected commit requires commandId and expectedRevision.', false)
        }
        validateSnapshot(body.snapshot)
        const nextSnapshot = upgradeSnapshotToLatest(body.snapshot as PJSDASSnapshot)
        const fingerprint = await fingerprintWorkspace(nextSnapshot)
        const current = await store.readForUser(identity.userId)
        if (!current) {
          throw new WorkspaceSourceError(
            'WORKSPACE_MIGRATION_REQUIRED',
            'This account has not explicitly migrated a workspace to connected mode.',
            false,
          )
        }
        const affectedObjects = diffCommandObjects(current.snapshot, nextSnapshot)
        const timestamp = new Date().toISOString()
        const result = await store.commitAuthoritativeForUser({
          userId: identity.userId,
          commandId: body.commandId,
          operation: 'SyncLocalSnapshot',
          payloadHash: await hashMutationPayload('SyncLocalSnapshot', {
            fingerprint,
            snapshotPurpose: body.snapshotPurpose,
          }),
          expectedRevision: body.expectedRevision!,
          snapshot: nextSnapshot,
          schemaVersion: nextSnapshot.version,
          principalKind: 'first_party_web',
          provenance: {
            channel: 'first-party-web-sync',
            snapshotPurpose: body.snapshotPurpose,
          },
          receiptContext: {
            contractVersion: 2,
            commandType: 'snapshot_compatibility',
            snapshotPurpose: body.snapshotPurpose,
            affectedObjects,
            undoDependencyObjects: affectedObjects,
            readModelInvalidation: readModelInvalidation(affectedObjects),
            lifecycle: {
              receivedAt: timestamp,
              validatedAt: timestamp,
              baseRevision: body.expectedRevision,
              authoritativeRevisionBeforeCommit: current.revision,
              rebased: false,
            },
          },
        })
        const status = result.outcome === 'CONFLICT' ? 409 : 200
        return json(status, {
          outcome: result.outcome,
          workspaceId: result.workspaceId,
          workspaceVersion: `txn:${result.revision}`,
          revision: result.revision,
          schemaVersion: nextSnapshot.version,
          snapshot: result.snapshot,
          receipt: result.receipt,
        }, origin, config.allowedOrigins)
      }

      throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Unknown connected workspace action.', false)
    } catch (caught) {
      const error = safeError(caught)
      const status = error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID' ? 401
        : error.code === 'AUTH_FORBIDDEN' || error.code === 'ORIGIN_NOT_ALLOWED' || error.code === 'AUDIENCE_ACCESS_REQUIRED' || error.code === 'AUDIENCE_IDENTITY_MISMATCH' ? 403
          : error.code === 'WORKSPACE_CONFLICT' ? 409
            : error.code === 'WORKSPACE_MIGRATION_REQUIRED' || error.code === 'CONFIRMATION_REQUIRED' ? 409
              : error.retryable ? 503
                : 400
      return json(status, { code: error.code, message: error.message, retryable: error.retryable }, origin, config.allowedOrigins)
    }
  }
}
