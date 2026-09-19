import { validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import {
  type ConnectedCommitResult,
  type MutationPrincipalKind,
  createTransactionalWorkspaceStore,
  type TransactionalWorkspaceStoreOptions,
} from './transactionalWorkspaceStore.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface MutationPrincipal {
  kind: MutationPrincipalKind
  userId: string
  clientId?: string
  sourceId?: string
}

export interface MutationCommand<TPayload = unknown> {
  commandId: string
  operation: string
  payload: TPayload
  expectedRevision: number
  provenance?: Record<string, unknown>
  effectiveTime?: string
}

export type MutationApply<TPayload> = (snapshot: PJSDASSnapshot, payload: TPayload) => PJSDASSnapshot | Promise<PJSDASSnapshot>

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  )
}

export async function hashMutationPayload(operation: string, payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize({ operation, payload })))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createMutationKernel(options: TransactionalWorkspaceStoreOptions) {
  const store = createTransactionalWorkspaceStore(options)

  return {
    async execute<TPayload>(
      principal: MutationPrincipal,
      command: MutationCommand<TPayload>,
      apply: MutationApply<TPayload>,
    ): Promise<ConnectedCommitResult> {
      if (!command.commandId.trim() || !command.operation.trim()) {
        throw new WorkspaceSourceError('INVALID_ARGUMENT', 'PJSDAS mutation command identity is required.', false)
      }
      if (principal.kind === 'delegated_mcp' && !principal.clientId) {
        throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Delegated PJSDAS commands require an authorized client identity.', false)
      }

      const current = await store.readForUser(principal.userId)
      if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'PJSDAS connected workspace has not been migrated yet.', false)
      if (current.revision !== command.expectedRevision) {
        return {
          outcome: 'CONFLICT',
          workspaceId: current.workspaceId,
          revision: current.revision,
          snapshot: current.snapshot,
          receipt: {
            commandId: command.commandId,
            status: 'CONFLICT',
            expectedRevision: command.expectedRevision,
            actualRevision: current.revision,
          },
        }
      }

      const next = await apply(structuredClone(current.snapshot), command.payload)
      validateSnapshot(next)
      const payloadHash = await hashMutationPayload(command.operation, command.payload)

      return store.commitForUser({
        userId: principal.userId,
        commandId: command.commandId,
        operation: command.operation,
        payloadHash,
        expectedRevision: command.expectedRevision,
        snapshot: next,
        schemaVersion: current.schemaVersion,
        principalKind: principal.kind,
        clientId: principal.clientId,
        provenance: {
          ...(command.provenance ?? {}),
          ...(principal.sourceId ? { sourceId: principal.sourceId } : {}),
        },
        effectiveTime: command.effectiveTime,
      })
    },
  }
}
