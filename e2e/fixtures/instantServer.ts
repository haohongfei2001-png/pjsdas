import type { BrowserContext } from '@playwright/test'
import { instantDenseWorkspace, INSTANT_NOW } from '../../tests/fixtures/instantDenseWorkspace.js'
import { applyUserDomainCommand, applyDomainCompensation } from '../../src/domainCommands.js'
import { diffWorkspaceDelta } from '../../src/workspaceDelta.js'
import { BACKEND, seedSession, health, cors } from './todayWorkspace.js'
export async function setupInstantServer(context: BrowserContext, historyRows = 3940) {
  let snapshot = instantDenseWorkspace(historyRows)
  let revision = 1204
  let readCount = 0
  const readAdmissions: Array<{ path: string; ordinal: number }> = []
  let nextConfirmation: Promise<void> | undefined
  let delay = 3000
  let serverNow = INSTANT_NOW
  const sent: string[] = []
  const receiptLookups: string[] = []
  const baseRevisions: Array<number | undefined> = []
  const payloadBytes: number[] = []
  const serverExecutionMs: number[] = []
  let deny: number | undefined
  let loseResponse = false
  let fullResponses = false
  const compensations = new Map<string, any>()
  const receipts = new Map<string, any>()
  await seedSession(context, 'instant-owner', 'instant-token')
  await context.route(`${BACKEND}/**`, async route => {
    if (route.request().method() === 'OPTIONS') return cors(route, {}, 204)
    if (route.request().url().endsWith('/api/health')) return cors(route, health())
    const body = route.request().postDataJSON()
    const base = () => ({ workspaceId: 'instant-workspace', revision, workspaceVersion: `txn:${revision}`, schemaVersion: snapshot.version, snapshot })
    if (body.action === 'read') { readCount++; if (readAdmissions.length < 1000) readAdmissions.push({ path: new URL(route.request().url()).pathname, ordinal: readCount }); return cors(route, base()) }
    if (body.action === 'receipt') {
      receiptLookups.push(body.commandId)
      const receipt = receipts.get(body.commandId)
      return cors(route, body.projection === 'delta-v1' ? { found: !!receipt, ...receipt } : { ...base(), found: !!receipt, receipt: receipt?.receipt })
    }
    if (body.action === 'command' || body.action === 'undo') {
      sent.push(body.commandId)
      baseRevisions.push(body.baseRevision)
      if (receipts.has(body.commandId)) return cors(route, { ...receipts.get(body.commandId), outcome: 'ALREADY_APPLIED' })
      const rejectThis = deny; deny = undefined
      const confirmation = nextConfirmation; nextConfirmation = undefined
      if (confirmation) await confirmation
      await new Promise(resolve => setTimeout(resolve, delay))
      if (rejectThis) return cors(route, { code: 'COMMAND_REJECTED' }, rejectThis)
      const executionStarted = performance.now()
      const before = snapshot
      if (body.action === 'undo') snapshot = applyDomainCompensation(snapshot, compensations.get(body.targetCommandId), serverNow)
      else { const evaluated = applyUserDomainCommand(snapshot, body.command.value, serverNow); if (evaluated.status === 'ALREADY_APPLIED') return cors(route, { outcome: 'ALREADY_APPLIED', revision, workspaceVersion: `txn:${revision}`, result: { status: 'ALREADY_APPLIED' }, recoveryRequired: true }); snapshot = evaluated.snapshot; if (evaluated.status === 'APPLIED') compensations.set(body.commandId, evaluated.compensation) }
      const delta = diffWorkspaceDelta(before, snapshot, revision++)
      const result = { outcome: 'COMMITTED', revision, workspaceVersion: `txn:${revision}`, schemaVersion: snapshot.version,
        delta, receipt: { commandId: body.commandId, revision, undoAvailable: true, undoCompensation: compensations.get(body.commandId) }  }
      serverExecutionMs.push(performance.now() - executionStarted)
      receipts.set(body.commandId, result)
      payloadBytes.push(Buffer.byteLength(JSON.stringify(result)))
      if (loseResponse) { loseResponse = false; return route.abort('failed') }
      const { delta: _delta, ...legacyResult } = result
      return cors(route, body.projection === 'delta-v1' && !fullResponses ? result : { ...base(), ...legacyResult, snapshot })
    }
    return cors(route, { code: 'UNEXPECTED' }, 400)
  })
  return { readAdmissions, holdNextConfirmation: () => { if (nextConfirmation) throw new Error('A confirmation barrier is already armed'); let release!: () => void; nextConfirmation = new Promise<void>(resolve => { release = resolve }); return () => release() }, backgroundCapacity: (minutes: number, now: Date) => { snapshot = applyUserDomainCommand(snapshot, { commandId: `other-device-${revision}`, kind: 'set_date_capacity', date: '2026-10-01', minutes }, now).snapshot; revision++ }, get readCount() { return readCount }, setFullResponses: (value: boolean) => { fullResponses = value }, sent, receiptLookups, baseRevisions, payloadBytes, serverExecutionMs, setNow: (value: Date) => { serverNow = value }, denyNext: (status = 422) => { deny = status }, loseNextResponse: () => { loseResponse = true }, backgroundGmail: () => { snapshot.data.timeline!.push({ id: 'instant-gmail-audit', kind: 'opportunity_updated', category: 'opportunity', source: 'user_action', title: 'Independent source fact', occurredAt: INSTANT_NOW.toISOString(), recordedAt: INSTANT_NOW.toISOString() }); snapshot.data.opportunities[10].role = 'Independent Gmail role'; revision++ }, setDelay: (value: number) => { delay = value }, get snapshot() { return snapshot } }
}
