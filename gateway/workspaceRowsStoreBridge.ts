import { createWorkspaceRowsCandidate, WorkspaceRowsCandidateError, type WorkspaceRowsCandidateOptions } from './workspaceRowsCandidate.js'
import { WorkspaceSourceError } from './workspaceSource.js'
import type { ConnectedAuthoritativeCommitInput, ConnectedWorkspaceRecord, TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'

/** Server-owned adapter shared by explicit fixtures and the dormant row runtime. */
export function createWorkspaceRowsStoreBridge(options: WorkspaceRowsCandidateOptions): Pick<TransactionalWorkspaceStoreOptions, 'rowLayoutReader' | 'rowLayoutWriter'> {
  const rows = createWorkspaceRowsCandidate(options)
  return {
    rowLayoutReader: rows,
    rowLayoutWriter: {
      async admitCapture(userId, epoch, expectedRevision, admission) {
        await rows.admitCapture({ userId, epoch, revision: expectedRevision }, admission)
      },
      async commit(before: ConnectedWorkspaceRecord, input: ConnectedAuthoritativeCommitInput) {
        if (!before.rowEpoch) throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'A server-read row generation is required.', false)
        // A lost-response retry may be supplied with a newly read preimage. Keep
        // its ORIGINAL expected revision for SQL replay-before-CAS. If stale,
        // send a no-op effect set: it can only replay or conflict, never overwrite
        // newer state with the obsolete request body (and cannot exceed delta caps).
        if (before.revision > input.expectedRevision) input = { ...input, snapshot: before.snapshot }
        const record = { workspaceId: before.workspaceId, userId: before.userId, revision: input.expectedRevision, epoch: before.rowEpoch, snapshot: before.snapshot }
        const audit = { commandId: input.commandId, payloadHash: input.payloadHash, compensation: input.compensation ?? null, provenance: input.provenance, receiptContext: input.receiptContext, effectiveTime: input.effectiveTime }
        try {
          let result
          if (input.managementAuthorization) {
            const grant = input.managementAuthorization
            if (!input.clientId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Original management client required.', false)
            const command = { ...audit, grantId: grant.grantId, grantRevision: grant.grantRevision, clientId: input.clientId, operation: input.operation, ...(input.operation === 'undo_command' ? { undoOf: input.provenance?.undoOf as string } : {}) }
            // The existing central store checks operation/consent/principal before
            // dispatch; each SQL entry independently revalidates original authority.
            switch (grant.consentVersion ?? 2) {
              case 2: result = await rows.commitLegacyManagement(record, input.snapshot, command as Parameters<typeof rows.commitLegacyManagement>[2]); break
              case 3: result = await rows.commitOpportunity(record, input.snapshot, command as Parameters<typeof rows.commitOpportunity>[2]); break
              case 4: result = await rows.commitPlanning(record, input.snapshot, command as Parameters<typeof rows.commitPlanning>[2]); break
              case 5: result = await rows.commitDiscoveryProfile(record, input.snapshot, command as Parameters<typeof rows.commitDiscoveryProfile>[2]); break
              case 6: result = await rows.commitPrivateReminder(record, input.snapshot, command as Parameters<typeof rows.commitPrivateReminder>[2]); break
              case 7: result = await rows.commitBusiness(record, input.snapshot, command as Parameters<typeof rows.commitBusiness>[2]); break
              default: throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Unsupported original grant family.', false)
            }
          } else if (input.aiCaptureAuthorization) {
            result = await rows.commitCapture(record, input.snapshot, { ...audit, requestId: input.aiCaptureAuthorization.requestId, observation: input.aiCaptureAuthorization.observation as unknown as Record<string, unknown> })
          } else if (input.discoveryAuthorization) {
            result = await rows.commitDiscovery(record, input.snapshot, { ...audit, operation: input.operation as 'checkpoint_discovery_search' | 'ingest_verified_discovery', principal: input.principalKind as 'automation' | 'delegated_mcp', clientId: input.clientId, provenance: input.provenance ?? {}, authorization: input.discoveryAuthorization as unknown as Record<string, unknown> })
          } else if (input.operation === 'gmail_semantic_intake') {
            if (input.principalKind !== 'automation' || input.clientId || input.provenance?.sourceId !== 'gmail:primary') throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Original Gmail automation source required.', false)
            result = await rows.commit(record, input.snapshot, { ...audit, operation: 'gmail_semantic_intake', principal: 'automation', sourceId: 'gmail:primary' })
          } else {
            result = await rows.commitAuthoritative(record, input.snapshot, { ...audit, operation: input.operation, principal: input.principalKind, ...(input.clientId ? { clientId: input.clientId } : {}) })
          }
          return { ...result, outcome: result.outcome as 'COMMITTED' | 'ALREADY_APPLIED' }
        } catch (error) {
          if (!(error instanceof WorkspaceRowsCandidateError)) throw error
          if (error.code === 'CONFLICT') return { outcome: 'CONFLICT' as const }
          const code = error.code === 'FORBIDDEN' ? 'AUTH_FORBIDDEN' : error.code === 'COMMAND_ID_REUSED' ? 'COMMAND_ID_REUSED' : error.code === 'INVALID' ? 'WORKSPACE_INVALID' : error.code === 'UNAVAILABLE' ? 'WORKSPACE_UNAVAILABLE' : 'WORKSPACE_CONFLICT'
          throw new WorkspaceSourceError(code, 'The row-compatible commit did not complete; no legacy fallback is permitted.', error.retryable)
        }
      },
    },
  }
}
