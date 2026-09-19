import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import {
  createTransactionalWorkspaceStore,
  type MutationPrincipalKind,
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

  return {
    async read() {
      const workspace = await store.readForUser(options.userId)
      if (!workspace) {
        throw new WorkspaceSourceError(
          'WORKSPACE_MIGRATION_REQUIRED',
          'PJSDAS connected workspace has not been explicitly migrated yet.',
          false,
        )
      }
      return {
        snapshot: workspace.snapshot,
        context: {
          now: now(),
          timezone,
          workspaceVersion: `txn:${workspace.revision}`,
        },
      }
    },

    async write(input: WorkspaceWriteInput) {
      const workspace = await store.readForUser(options.userId)
      if (!workspace) {
        throw new WorkspaceSourceError(
          'WORKSPACE_MIGRATION_REQUIRED',
          'PJSDAS connected workspace has not been explicitly migrated yet.',
          false,
        )
      }
      const expectedRevision = revisionFromWorkspaceVersion(input.expectedWorkspaceVersion)
      if (expectedRevision === undefined) {
        throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Transactional writes require an exact expected revision.', false)
      }
      const fingerprint = await fingerprintWorkspace(input.snapshot)
      const writer = input.updatedByDevice?.trim() || options.sourceId || options.principalKind
      const result = await store.commitForUser({
        userId: options.userId,
        commandId: `snapshot-write:${writer}:${fingerprint}`,
        operation: 'SnapshotWrite',
        payloadHash: fingerprint,
        expectedRevision,
        snapshot: input.snapshot,
        schemaVersion: input.snapshot.version,
        principalKind: options.principalKind,
        clientId: options.clientId,
        provenance: {
          writer,
          ...(options.sourceId ? { sourceId: options.sourceId } : {}),
        },
        effectiveTime: input.snapshot.exportedAt,
      })
      if (result.outcome === 'CONFLICT') {
        throw new WorkspaceSourceError(
          'WORKSPACE_CONFLICT',
          `PJSDAS connected workspace changed since revision ${expectedRevision}; retry from txn:${result.revision}.`,
          true,
        )
      }
      return {
        snapshot: result.snapshot,
        context: {
          now: now(),
          timezone,
          workspaceVersion: `txn:${result.revision}`,
        },
      }
    },
  }
}
