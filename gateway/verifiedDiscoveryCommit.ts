import { applyUserDomainCommand } from '../src/domainCommands.js'
import { discoveryProfileManagementFingerprint } from '../src/discoveryProfileManagement.js'
import { discoveryCommandRun, verifiedDiscoveryCommandSchema, type VerifiedDiscoveryCommand } from '../src/verifiedDiscoveryCommand.js'
import { hashMutationPayload } from './mutationKernel.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError, type GatewayWorkspace, type WorkspaceSource, type DiscoveryCommitAuthorization } from './workspaceSource.js'

export async function verifiedDiscoveryCommandId(sourceId: string, runId: string) {
  return `verified-discovery:${await hashMutationPayload('discovery_run_identity', [sourceId, runId])}`
}

export async function prepareVerifiedDiscoveryCommand(input: {
  run: VerifiedDiscoveryCommand['run']; request: unknown; scopeFingerprint?: string
}): Promise<VerifiedDiscoveryCommand> {
  return verifiedDiscoveryCommandSchema.parse({ commandId: await verifiedDiscoveryCommandId(input.run.sourceId, input.run.runId), kind: 'ingest_verified_discovery',
    inputFingerprint: await hashMutationPayload('ingest_verified_discovery', input.request), scopeFingerprint: input.scopeFingerprint, run: input.run })
}

function recordedResult(workspace: GatewayWorkspace, command: VerifiedDiscoveryCommand) {
  const run = discoveryCommandRun(workspace.snapshot, command.run.sourceId, command.run.runId)
  if (!run || run.inputFingerprint !== command.inputFingerprint || run.commandId !== command.commandId) return undefined
  return { snapshot: workspace.snapshot, run, records: [], alreadyApplied: true,
    createdOpportunityIds: [], touchedOpportunityIds: [], processEventIds: [] }
}

type CommandIdentity = Pick<VerifiedDiscoveryCommand, 'commandId' | 'kind' | 'inputFingerprint'>
function workspaceRevision(workspaceVersion: string | undefined) {
  const match = /^txn:(\d+)$/.exec(workspaceVersion ?? '')
  return match ? Number(match[1]) : undefined
}
function receiptMatches(receipt: Record<string, unknown> | undefined, command: CommandIdentity, revision: number) {
  return receipt?.commandId === command.commandId && receipt.operation === command.kind
    && receipt.receiptId === `command-receipt:${command.commandId}` && receipt.status === 'COMMITTED'
    && receipt.revision === revision
}

/** A snapshot marker alone is not proof of the command that wrote it. Join the
 * account-scoped ledger identity, payload hash and revision to its real receipt. */
export async function readVerifiedDiscoveryReceipt(source: WorkspaceSource, command: CommandIdentity, workspaceVersion: string | undefined) {
  const recorded = await source.readCommandReceipt?.(command.commandId)
  if (!recorded) return undefined
  return validateDiscoveryReceipt(recorded, command, workspaceVersion)
}

export function validateDiscoveryReceipt(recorded: NonNullable<Awaited<ReturnType<NonNullable<WorkspaceSource['readCommandReceipt']>>>>,
  command: CommandIdentity, workspaceVersion: string | undefined) {
  const revision = workspaceRevision(workspaceVersion)
  if (recorded.commandId !== command.commandId || recorded.operation !== command.kind
    || recorded.payloadHash !== command.inputFingerprint || !Number.isSafeInteger(recorded.resultingRevision)
    || recorded.resultingRevision < 1 || revision === undefined || recorded.resultingRevision > revision
    || !receiptMatches(recorded.receipt, command, recorded.resultingRevision)) {
    throw new WorkspaceSourceError('DISCOVERY_RECEIPT_MISMATCH', 'The authoritative receipt does not match this Discovery command, payload or workspace revision.', false)
  }
  return recorded.receipt
}

/** Retries only the deterministic domain/CAS step, never retrieval. A lost ACK
 * is reconciled against the same command and authoritative run before reporting. */
export async function commitVerifiedDiscoveryRun(source: WorkspaceSource, command: VerifiedDiscoveryCommand, options: {
  authorize?: () => Promise<void>
  discoveryAuthorization?: DiscoveryCommitAuthorization
  validateWorkspace?: (workspace: GatewayWorkspace) => void | Promise<void>
  now?: () => Date
} = {}) {
  const writable = requireWritableWorkspaceSource(source)
  if (!source.readCommandReceipt) throw new WorkspaceSourceError('DISCOVERY_AUTHORITATIVE_COMMAND_REQUIRED', 'Automatic Discovery requires the connected command ledger and authoritative receipts.', false)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await options.authorize?.()
    const workspace = await source.read()
    const appliedAt = options.now?.() ?? workspace.context.now ?? new Date()
    const previous = recordedResult(workspace, command)
    if (previous) {
      const receipt = await readVerifiedDiscoveryReceipt(source, command, workspace.context.workspaceVersion)
      if (!receipt) throw new WorkspaceSourceError('DISCOVERY_COMMIT_UNVERIFIED', 'This run has no matching authoritative command receipt.', true)
      return { result: previous, workspaceVersion: workspace.context.workspaceVersion,
        durableCommit: true, readbackVerified: true, receipt, commandId: command.commandId }
    }
    if (command.scopeFingerprint && await discoveryProfileManagementFingerprint(workspace.snapshot.data.discoveryProfile ?? null) !== command.scopeFingerprint) {
      throw new WorkspaceSourceError('DISCOVERY_SCOPE_CHANGED', 'The confirmed search scope changed before commit; stale additions were not saved.', false)
    }
    await options.validateWorkspace?.(workspace)
    const applied = applyUserDomainCommand(workspace.snapshot, command, appliedAt)
    await options.authorize?.()
    let written: GatewayWorkspace
    try {
      written = await writable.write({ snapshot: applied.snapshot, expectedWorkspaceVersion: workspace.context.workspaceVersion,
        updatedByDevice: `verified-discovery:${command.run.sourceId}`,
        command: { commandId: command.commandId, operation: command.kind, payload: command,
          payloadHash: command.inputFingerprint, effectiveTime: appliedAt.toISOString(),
          discoveryAuthorization: options.discoveryAuthorization,
          provenance: { producer: command.run.producer, sourceId: command.run.sourceId,
            scopeFingerprint: command.scopeFingerprint, runId: command.run.runId } } })
    } catch (caught) {
      if (caught instanceof WorkspaceSourceError && caught.code === 'WORKSPACE_CONFLICT' && attempt === 0) continue
      const recovered = await source.read().catch(() => undefined)
      const result = recovered && recordedResult(recovered, command)
      if (result) {
        const receipt = await readVerifiedDiscoveryReceipt(source, command, recovered!.context.workspaceVersion)
        if (receipt) return { result, workspaceVersion: recovered!.context.workspaceVersion,
          durableCommit: true, readbackVerified: true, receipt, commandId: command.commandId }
      }
      throw caught
    }
    const stored = recordedResult(written, command)
    if (!stored) throw new WorkspaceSourceError('DISCOVERY_COMMIT_UNVERIFIED', 'The write response did not establish the expected Discovery command. Read its receipt before retrying.', true)
    const receiptRevision = written.commandReceipt?.revision
    const writtenRevision = workspaceRevision(written.context.workspaceVersion)
    if (typeof receiptRevision !== 'number' || !Number.isSafeInteger(receiptRevision) || receiptRevision < 1
      || writtenRevision === undefined || receiptRevision > writtenRevision
      || !['COMMITTED', 'ALREADY_APPLIED'].includes(written.commandOutcome ?? '')
      || written.commandOutcome === 'COMMITTED' && (receiptRevision !== writtenRevision || receiptRevision !== (workspaceRevision(workspace.context.workspaceVersion) ?? -1) + 1)
      || !receiptMatches(written.commandReceipt, command, receiptRevision)) {
      throw new WorkspaceSourceError('DISCOVERY_RECEIPT_MISMATCH', 'The commit response did not contain the matching authoritative command receipt. Reconcile it before retrying.', false)
    }
    const result = written.commandOutcome === 'ALREADY_APPLIED' ? stored : { ...applied.ingestion, snapshot: written.snapshot, run: stored.run }
    const readback = await source.read().catch(() => undefined)
    const receipt = readback ? await readVerifiedDiscoveryReceipt(source, command, readback.context.workspaceVersion).catch(caught => {
      if (caught instanceof WorkspaceSourceError && caught.code === 'DISCOVERY_RECEIPT_MISMATCH') throw caught
      return undefined
    }) : undefined
    const readbackVerified = Boolean(receipt && readback && recordedResult(readback, command))
    if (receipt && receipt.revision !== receiptRevision) throw new WorkspaceSourceError('DISCOVERY_RECEIPT_MISMATCH', 'The write response and authoritative ledger refer to different original commit revisions.', false)
    return { result, workspaceVersion: readback?.context.workspaceVersion ?? written.context.workspaceVersion,
      durableCommit: true, readbackVerified, receipt: receipt ?? written.commandReceipt, commandId: command.commandId,
      ...(readbackVerified ? {} : { verificationWarning: 'The commit succeeded; independent readback is pending. Do not report an uncommitted failure or replay retrieval.' }) }
  }
  throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Discovery facts were not committed after the bounded CAS retry.', true)
}
