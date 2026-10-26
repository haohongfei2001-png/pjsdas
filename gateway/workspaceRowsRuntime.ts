import type { TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'
import { createWorkspaceRowsStoreBridge } from './workspaceRowsStoreBridge.js'
import { createWorkspaceRowsStagedBridge } from './workspaceRowsStagedBridge.js'
import { workspaceRowsReleaseProfiles } from './workspaceRowsReleaseProfile.js'
import { WorkspaceSourceError } from './workspaceSource.js'

/** Dormant shared backend wiring. Flags are not an activation/migration API:
 * per-owner layout markers still gate all row operations in SQL and the store.
 * Never cache a fetch closure: controlled workers supply a deadline-bound one.
 * An activated layout requires a row-compatible release and reads kept enabled. */
export function withWorkspaceRowsRuntime<T extends TransactionalWorkspaceStoreOptions>(options: T,
  env: { PJSDAS_WORKSPACE_ROWS_READS?: string; PJSDAS_WORKSPACE_ROWS_WRITES?: string; PJSDAS_WORKSPACE_ROWS_READ_CONCURRENCY?: string; PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS?: string; PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT?: string; PJSDAS_WORKSPACE_ROWS_DURABLE_ATTEMPTS_V2?: string; PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES?: string; PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES?: string; PJSDAS_WORKSPACE_ROWS_AUDIT_ADMISSION_MODE?: string; PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION?: string; PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE?: string } = process.env): T {
  // Explicit server/test injections are one complete adapter, not composable
  // with unrelated ambient writers or credentials.
  if (options.rowLayoutReader || options.rowLayoutWriter) return options
  const reads = env.PJSDAS_WORKSPACE_ROWS_READS === '1'
  const writes = env.PJSDAS_WORKSPACE_ROWS_WRITES === '1'
  const staged = env.PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS === '1'
  const auditPagesEnabled = env.PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES === '1'
  const auditReadsEnabled = env.PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES === '1'
  if (auditPagesEnabled && !auditReadsEnabled) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Audit pages require complete audit byte reads.', false)
  if (auditReadsEnabled && !reads) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Audit byte reads require compatible row reads.', false)
  const durableIntent = env.PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT === '1'
  const durableAttemptsV2 = env.PJSDAS_WORKSPACE_ROWS_DURABLE_ATTEMPTS_V2 === '1'
  if (env.PJSDAS_WORKSPACE_ROWS_DURABLE_ATTEMPTS_V2 !== undefined && !['0', '1'].includes(env.PJSDAS_WORKSPACE_ROWS_DURABLE_ATTEMPTS_V2)) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Invalid durable v2 capability.', false)
  if (durableAttemptsV2 && !durableIntent) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Durable attempts v2 requires durable intent recovery.', false)
  const profile = env.PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE
  if (profile !== undefined && !Object.hasOwn(workspaceRowsReleaseProfiles, profile))
    throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Unknown preloaded row release profile.', false)
  const profileMode = profile === undefined ? undefined : workspaceRowsReleaseProfiles[profile]
  if (profileMode && (!staged || !auditReadsEnabled || !durableIntent || profileMode === 'pages-v1' && !auditPagesEnabled))
    throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Row release profile requires its explicit original staged, durable and audit capabilities.', false)
  if (profileMode && env.PJSDAS_WORKSPACE_ROWS_AUDIT_ADMISSION_MODE !== undefined && profileMode !== env.PJSDAS_WORKSPACE_ROWS_AUDIT_ADMISSION_MODE)
    throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Conflicting server audit admission selectors.', false)
  const admissionMode = env.PJSDAS_WORKSPACE_ROWS_AUDIT_ADMISSION_MODE ?? profileMode
  if (admissionMode !== undefined && (!['fragments-v1', 'pages-v1'].includes(admissionMode) || !auditReadsEnabled || !staged))
    throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Audit admission mode requires a known staged complete audit byte capability.', false)
  const durableAdmission = env.PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION
  if (durableAdmission !== undefined && (!['0', '1'].includes(durableAdmission) || !durableIntent))
    throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Durable admission control requires durable recovery to remain enabled.', false)
  if (durableIntent && !staged) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Durable intent requires the original staged document capability.', false)
  if (staged && (!reads || !writes)) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Staged documents require compatible row reads and writes.', false)
  if (writes && !reads) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Row writers require row-compatible reads.', false)
  if (!reads) return options
  const concurrency = env.PJSDAS_WORKSPACE_ROWS_READ_CONCURRENCY ?? '1'
  if (!/^[1-4]$/.test(concurrency)) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Invalid bounded row read concurrency.', false)
  // Server-only and default-off. Requires prior SQL/read-fence capability and
  // durable reservation provisioning. No browser body or writer fallback can
  // select this mode. Missing prerequisites fail closed; no quota is invented.
  // Caller cancellation must NOT replace the candidate's existing per-request
  // timeout with an unbounded Request.signal. Combine at transport instead.
  const callerBoundFetch: typeof fetch | undefined = options.signal ? (input, init) => (options.fetchImpl ?? fetch)(input,
    { ...init, signal: init?.signal ? AbortSignal.any([init.signal, options.signal!]) : options.signal }) : options.fetchImpl
  const bridge = (staged ? createWorkspaceRowsStagedBridge : createWorkspaceRowsStoreBridge)({ supabaseUrl: options.supabaseUrl,
    serviceRoleKey: options.serviceRoleKey, fetchImpl: staged ? options.fetchImpl : callerBoundFetch,
    ...(staged ? { signal: options.signal, durableIntent, durableAttemptsV2, durableIntentAdmissionEnabled: durableAdmission !== '0', auditAdmissionMode: admissionMode as 'fragments-v1' | 'pages-v1' | undefined } : {}),
    readsEnabled: true, writesEnabled: writes, auditReadsEnabled, auditPagesEnabled, auditReadAuthorization: options.auditReadAuthorization, rpcTransport: 'public-v1', readConcurrency: Number(concurrency) })
  return { ...options, rowLayoutReader: bridge.rowLayoutReader,
    ...(writes ? { rowLayoutWriter: bridge.rowLayoutWriter } : {}) }
}
