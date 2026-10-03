import { resolvePlanningTimezone } from '../src/timePlanningPreferences.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import { hashMutationPayload } from './mutationKernel.js'
import { diffCommandObjects, readModelInvalidation } from './commandObjects.js'
import {
  createTransactionalWorkspaceStore,
  type MutationPrincipalKind,
  type ConnectedWorkspaceRecord,
} from './transactionalWorkspaceStore.js'
import {
  WorkspaceSourceError,
  type WorkspaceSource,
  type WorkspaceWriteInput,
} from './workspaceSource.js'

export interface TransactionalWorkspaceSourceOptions {
  userId: string
  supabaseUrl: string
  serviceRoleKey: string
  principalKind: MutationPrincipalKind
  clientId?: string
  sourceId?: string
  timezone?: string
  fetchImpl?: typeof fetch
  now?: () => Date
  reuseReadPreimage?: boolean
}

function revisionFromWorkspaceVersion(value: string | undefined) {
  if (!value) return undefined
  const match = /^txn:(\d+)$/.exec(value)
  if (!match) {
    throw new WorkspaceSourceError('WORKSPACE_CONFLICT', `Expected a transactional workspace revision, received ${value}.`, false)
  }
  return Number(match[1])
}

export function createTransactionalWorkspaceSource(options: TransactionalWorkspaceSourceOptions): WorkspaceSource {
  const store = createTransactionalWorkspaceStore({
    supabaseUrl: options.supabaseUrl,
    serviceRoleKey: options.serviceRoleKey,
    fetchImpl: options.fetchImpl,
  })
  const now = options.now ?? (() => new Date())
  const timezone = options.timezone?.trim() || 'UTC'
  let readPreimage: ConnectedWorkspaceRecord | undefined

  return {
    async read() {
      readPreimage = undefined
      const workspace = await store.readForUser(options.userId, { includeStoredSchema: options.reuseReadPreimage })
      if (!workspace) {
        throw new WorkspaceSourceError(
          'WORKSPACE_MIGRATION_REQUIRED',
          'TodayAction connected workspace has not been explicitly migrated yet.',
          false,
        )
      }
      // Private one-shot preimage; callers may mutate the returned snapshot.
      // Reuse never survives this source instance or bypasses server CAS.
      readPreimage = options.reuseReadPreimage ? structuredClone(workspace) : undefined
      return {
        snapshot: workspace.snapshot,
        context: {
          now: now(),
          timezone: resolvePlanningTimezone(workspace.snapshot.data.timePlanning, timezone),
          workspaceVersion: `txn:${workspace.revision}`,
          workspaceOwnerUserId: options.userId,
        },
      }
    },

    async write(input: WorkspaceWriteInput) {
      const expectedRevision = revisionFromWorkspaceVersion(input.expectedWorkspaceVersion)
      const observed = readPreimage
      readPreimage = undefined
      let workspace: ConnectedWorkspaceRecord | null
      if (observed?.userId === options.userId && observed.revision === expectedRevision) {
        const identity = await store.readIdentityForUser(options.userId)
        if (!identity) workspace = null
        else if (identity.workspaceId !== observed.workspaceId || identity.revision !== observed.revision || identity.schemaVersion !== observed.storedSchemaVersion) {
          throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'The observed workspace identity or revision changed; read it again before writing.', true)
        } else workspace = observed
      } else workspace = await store.readForUser(options.userId)
      if (!workspace) {
        throw new WorkspaceSourceError(
          'WORKSPACE_MIGRATION_REQUIRED',
          'TodayAction connected workspace has not been explicitly migrated yet.',
          false,
        )
      }
      if (expectedRevision === undefined) {
        throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Transactional writes require an exact expected revision.', false)
      }
      const fingerprint = await fingerprintWorkspace(input.snapshot)
      const writer = input.updatedByDevice?.trim() || options.sourceId || options.principalKind
      const semanticCommand = input.command
      const payloadHash = semanticCommand?.payloadHash
        ?? (semanticCommand ? await hashMutationPayload(semanticCommand.operation, semanticCommand.payload) : fingerprint)
      const affectedObjects = diffCommandObjects(workspace.snapshot, input.snapshot)
      const timestamp = now().toISOString()
      const result = await store.commitAuthoritativeForUser({
        userId: options.userId,
        commandId: semanticCommand?.commandId ?? `snapshot-write:${writer}:${expectedRevision}:${fingerprint}`,
        operation: semanticCommand?.operation ?? 'SnapshotWrite',
        payloadHash,
        expectedRevision,
        snapshot: input.snapshot,
        schemaVersion: input.snapshot.version,
        principalKind: options.principalKind,
        clientId: options.clientId,
        provenance: {
          writer,
          ...(options.sourceId ? { sourceId: options.sourceId } : {}),
          ...(semanticCommand?.provenance ?? {}),
        },
        compensation: semanticCommand?.compensation,
        effectiveTime: semanticCommand?.effectiveTime ?? input.snapshot.exportedAt,
        receiptContext: {
          contractVersion: 2,
          commandType: semanticCommand ? 'workspace_source_semantic' : 'workspace_source_compatibility',
          affectedObjects,
          undoDependencyObjects: affectedObjects,
          readModelInvalidation: readModelInvalidation(affectedObjects),
          lifecycle: {
            receivedAt: timestamp,
            validatedAt: timestamp,
            baseRevision: expectedRevision,
            authoritativeRevisionBeforeCommit: expectedRevision,
            rebased: false,
          },
        },
      })
      if (result.outcome === 'CONFLICT') {
        throw new WorkspaceSourceError(
          'WORKSPACE_CONFLICT',
          `TodayAction connected workspace changed since revision ${expectedRevision}; retry from txn:${result.revision}.`,
          true,
        )
      }
      return {
        snapshot: result.snapshot,
        context: {
          now: now(),
          timezone: resolvePlanningTimezone(result.snapshot.data.timePlanning, timezone),
          workspaceVersion: `txn:${result.revision}`,
          workspaceOwnerUserId: options.userId,
        },
      }
    },

    async prepareUndo(targetCommandId: string) {
      const current = await store.readForUser(options.userId)
      if (!current) {
        throw new WorkspaceSourceError(
          'WORKSPACE_MIGRATION_REQUIRED',
          'TodayAction connected workspace has not been explicitly migrated yet.',
          false,
        )
      }
      const target = await store.readCommandForUser(options.userId, targetCommandId)
      if (!target) return { outcome: 'NEEDS_CONFIRMATION' as const, reason: 'COMMAND_NOT_FOUND' as const }
      if (!target.compensation) {
        return {
          outcome: 'NEEDS_CONFIRMATION' as const,
          reason: 'NO_COMPENSATION' as const,
          targetRevision: target.resultingRevision,
          currentRevision: current.revision,
        }
      }
      if (target.resultingRevision !== current.revision) {
        return {
          outcome: 'NEEDS_CONFIRMATION' as const,
          reason: 'DEPENDENT_CHANGES' as const,
          targetRevision: target.resultingRevision,
          currentRevision: current.revision,
        }
      }
      return {
        outcome: 'READY' as const,
        targetCommandId,
        expectedWorkspaceVersion: `txn:${current.revision}`,
        snapshot: current.snapshot,
        compensation: target.compensation,
      }
    },
  }
}
