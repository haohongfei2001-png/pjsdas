import { consumerWorkspaceBootstrapSchema, createEmptyConsumerWorkspace } from '../src/consumerWorkspaceBootstrap.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import type { createTransactionalWorkspaceStore, ConnectedWorkspaceRecord } from './transactionalWorkspaceStore.js'
import { WorkspaceSourceError } from './workspaceSource.js'

type BootstrapStore = Pick<ReturnType<typeof createTransactionalWorkspaceStore>, 'readForUser' | 'bootstrapForUser'>
function owned(workspace: ConnectedWorkspaceRecord, userId: string) {
  if (workspace.userId !== userId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Workspace ownership did not match the verified account.', false)
  return workspace
}
/** Caller must use the existing first-party identity/origin/audience boundary.
 * The production handler feature gate is off by default. No grant is created.
 */
export async function initializeEmptyConsumerWorkspace(store: BootstrapStore, userId: string, raw: unknown, now = new Date(), audienceMode: 'allowlist' | 'legacy' = 'allowlist') {
  const parsed = consumerWorkspaceBootstrapSchema.safeParse(raw)
  if (!parsed.success) throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Explicit empty-workspace choices are invalid.', false)
  const input = parsed.data
  if (input.expectedAccountId !== userId) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'The account changed. Choose again for the current account.', false)
  if (!userId.trim()) throw new WorkspaceSourceError('AUTH_REQUIRED', 'A verified account is required.', false)
  const existing = await store.readForUser(userId, { preserveRawData: true })
  if (existing) return { outcome: 'EXISTING_WORKSPACE' as const, workspace: owned(existing, userId) }
  const snapshot = createEmptyConsumerWorkspace(input, now)
  const result = await store.bootstrapForUser({ userId, snapshot, schemaVersion: snapshot.version, sourceFingerprint: await fingerprintWorkspace(snapshot), migratedFrom: 'explicit-consumer-empty-start', consumerAudienceMode: audienceMode })
  // The existing SQL bootstrap uses UNIQUE(user_id) and never replaces an
  // existing snapshot. A concurrent initializer/import may win; return its state.
  return { outcome: 'INITIALIZED_OR_EXISTING' as const, workspace: owned(result, userId) }
}
