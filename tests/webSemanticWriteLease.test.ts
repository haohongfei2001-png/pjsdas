import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Opportunity, SemanticCandidate } from '../src/model.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import * as semantics from '../src/semanticIntake.js'
import * as interpretation from '../src/webSemanticInterpretation.js'
import { canonicalWorkspaceJson } from '../src/cloud/workspaceFingerprint.js'
import { AccountCacheChangedError, beginAccountCacheSessionResolution, setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
import { WorkspaceWriteAuthError } from '../src/cloud/workspaceWriteLease.js'
import { bindLocalWorkspaceToUser, clearLocalWorkspaceBinding, getCloudDeviceState } from '../src/cloud/syncState.js'

const boundary = vi.hoisted(() => ({
  read: vi.fn(), opportunities: vi.fn(), inbox: vi.fn(), replace: vi.fn(),
  authorityEnabled: vi.fn(), execute: vi.fn(), confirm: vi.fn(), queue: vi.fn(), undo: vi.fn(),
  commandId: vi.fn(),
}))
vi.mock('../src/db.js', () => ({
  exportLocalSnapshot: boundary.read,
  getAllOpportunities: boundary.opportunities,
  replaceLocalSnapshotFromCloud: boundary.replace,
}))
vi.mock('../src/discoveryInboxStore.js', () => ({ getAllDiscoveryInboxItems: boundary.inbox }))
vi.mock('../src/cloud/connectedWorkspaceRepository.js', () => ({ connectedWorkspaceAuthorityEnabled: boundary.authorityEnabled }))
vi.mock('../src/cloud/authoritativeCommandClient.js', () => ({
  executeConnectedBusinessCommand: boundary.execute,
  confirmConnectedCommand: boundary.confirm,
  queueConnectedBusinessCommand: boundary.queue,
  undoConnectedBusinessCommand: boundary.undo,
  createConnectedCommandId: boundary.commandId,
}))
import { resolveWebDecision, submitWebSemanticCapture, undoWebSemanticChange, type LocalSemanticUndoToken } from '../src/webSemanticIntake.js'

const NOW = new Date('2026-10-08T10:00:00.000Z')
const TEXT = 'Example Co Product Manager 已投递成功。'
const CAPTURE = { now: NOW, timezone: 'UTC', commandId: 'write-admission-test' }
let current: PJSDASSnapshot
let commits: number
let beforeCommit: (() => void | Promise<void>) | undefined
let dispatch: ReturnType<typeof vi.fn>
let semanticSpies: ReturnType<typeof vi.spyOn>[]

function opportunity(id = 'opp-1', role = 'Product Manager'): Opportunity {
  return { id, company: 'Example Co', role, currentStageLabel: '待投递', processStage: 'not_applied',
    roleType: 'core', participationStatus: 'active', early: false, opportunityValue: 80, fitScore: 80,
    locallyManaged: true, importedAt: '2026-10-01T00:00:00.000Z' }
}
function fixture(opportunities = [opportunity()]) {
  return createSnapshot({ opportunities, processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] }, NOW.toISOString())
}
function bindAccount(account = 'account-a') {
  setAccountCacheSession(account)
  bindLocalWorkspaceToUser(account)
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}
function clearObservations() {
  for (const mock of Object.values(boundary)) mock.mockClear()
  for (const spy of semanticSpies) spy.mockClear()
  dispatch.mockClear()
  commits = 0
}
function expectNoMutation(before: PJSDASSnapshot) {
  expect(current).toEqual(before)
  expect(commits).toBe(0)
  expect(dispatch).not.toHaveBeenCalled()
  expect(boundary.queue).not.toHaveBeenCalled()
  expect(boundary.execute).not.toHaveBeenCalled()
  expect(boundary.confirm).not.toHaveBeenCalled()
  expect(boundary.undo).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  const entries = new Map<string, string>()
  dispatch = vi.fn()
  vi.stubGlobal('window', { dispatchEvent: dispatch, localStorage: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
    removeItem: (key: string) => { entries.delete(key) },
  } })
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected live network access in an offline test') }))
  setAccountCacheSession(undefined)
  current = fixture()
  commits = 0
  beforeCommit = undefined
  boundary.read.mockImplementation(async (assertCurrent?: () => void) => { assertCurrent?.(); return structuredClone(current) })
  boundary.opportunities.mockImplementation(async () => structuredClone(current.data.opportunities))
  boundary.inbox.mockResolvedValue([])
  boundary.authorityEnabled.mockReturnValue(true)
  boundary.commandId.mockReturnValue('connected-command-1')
  boundary.execute.mockResolvedValue({ outcome: 'COMMITTED', result: { status: 'APPLIED', summary: 'Authoritative commit', decisionRequestIds: [] }, receipt: { undoAvailable: true } })
  boundary.confirm.mockResolvedValue({ outcome: 'ALREADY_APPLIED', result: { status: 'ALREADY_APPLIED', summary: 'Authoritative receipt' }, receipt: { undoAvailable: true } })
  boundary.queue.mockResolvedValue(undefined)
  boundary.undo.mockResolvedValue({ outcome: 'COMMITTED', result: { status: 'UNDONE' } })
  // Model the existing atomic replacement boundary. A missing guard is a test
  // failure, and the staged snapshot is published only after its final check.
  boundary.replace.mockImplementation(async (next: PJSDASSnapshot, guard?: { expectedLocal: PJSDASSnapshot; assertCurrent: () => void }) => {
    expect(guard?.expectedLocal).toBeDefined()
    expect(guard?.assertCurrent).toBeTypeOf('function')
    await beforeCommit?.()
    guard!.assertCurrent()
    if (canonicalWorkspaceJson(current) !== canonicalWorkspaceJson(guard!.expectedLocal)) throw new AccountCacheChangedError()
    current = structuredClone(next)
    commits += 1
  })
  // Spies preserve real interpretation, domain mutation, and compensation.
  semanticSpies = [
    vi.spyOn(interpretation, 'buildWebSemanticInterpretation'),
    vi.spyOn(semantics, 'applySemanticIntake'),
    vi.spyOn(semantics, 'resolveSemanticDecision'),
    vi.spyOn(semantics, 'applySemanticCompensation'),
  ]
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const emptyUndo: LocalSemanticUndoToken = { workspaceFingerprint: 'unused', compensation: {
  operation: 'semantic_batch', payload: { domainCompensations: [], decisionRequestIds: [], receiptIds: [] },
} }

describe('semantic writes reject unauthenticated fallback before all work', () => {
  const states = [
    { name: 'bound A before Auth resolution', active: undefined, owner: 'account-a', unresolved: true },
    { name: 'retained active A during new Auth resolution', active: 'account-a', owner: 'account-a', unresolved: true },
    { name: 'bound active A with omitted caller key', active: 'account-a', owner: 'account-a' },
    { name: 'active A before binding with omitted caller key', active: 'account-a', owner: undefined },
    { name: 'resolved anonymous session retaining bound A', active: undefined, owner: 'account-a' },
  ]
  for (const state of states) {
    it.each(['capture', 'queued capture', 'decision', 'undo'] as const)(`${state.name}: %s cannot read, interpret, compensate, queue, or report success`, async action => {
      setAccountCacheSession(state.active)
      if (state.owner) bindLocalWorkspaceToUser(state.owner)
      if (state.unresolved) beginAccountCacheSessionResolution()
      const before = structuredClone(current)
      const operation = action === 'capture' || action === 'queued capture'
        ? submitWebSemanticCapture(TEXT, { ...CAPTURE, queueOffline: action === 'queued capture' })
        : action === 'decision' ? resolveWebDecision('request-1', 'choice-1', { now: NOW })
          : undoWebSemanticChange(emptyUndo, NOW)
      await expect(operation).rejects.toMatchObject({ code: 'ACCOUNT_WRITE_UNCONFIRMED' })
      expect(boundary.read).not.toHaveBeenCalled()
      expect(boundary.opportunities).not.toHaveBeenCalled()
      expect(boundary.inbox).not.toHaveBeenCalled()
      expect(boundary.replace).not.toHaveBeenCalled()
      for (const spy of semanticSpies) expect(spy).not.toHaveBeenCalled()
      expectNoMutation(before)
    })
  }

  it.each(['capture', 'queued capture', 'decision', 'undo'] as const)('rejects wrong account B in %s before any read or outbox action', async action => {
    bindAccount()
    const before = structuredClone(current)
    const operation = action === 'capture' || action === 'queued capture'
      ? submitWebSemanticCapture(TEXT, { ...CAPTURE, accountKey: 'account-b', queueOffline: action === 'queued capture' })
      : action === 'decision' ? resolveWebDecision('request', 'choice', { accountKey: 'account-b' })
        : undoWebSemanticChange({ kind: 'connected', accountKey: 'account-b', targetCommandId: 'old-command' })
    await expect(operation).rejects.toBeInstanceOf(WorkspaceWriteAuthError)
    expect(boundary.read).not.toHaveBeenCalled()
    expect(boundary.opportunities).not.toHaveBeenCalled()
    expect(boundary.inbox).not.toHaveBeenCalled()
    expect(boundary.replace).not.toHaveBeenCalled()
    for (const spy of semanticSpies) expect(spy).not.toHaveBeenCalled()
    expectNoMutation(before)
  })

  it.each(['capture', 'queued capture', 'decision', 'undo'] as const)('does not treat a retained explicit account A as resolved Auth in %s', async action => {
    bindAccount()
    beginAccountCacheSessionResolution()
    const before = structuredClone(current)
    const operation = action === 'capture' || action === 'queued capture'
      ? submitWebSemanticCapture(TEXT, { ...CAPTURE, accountKey: 'account-a', queueOffline: action === 'queued capture' })
      : action === 'decision' ? resolveWebDecision('request', 'choice', { accountKey: 'account-a' })
        : undoWebSemanticChange({ kind: 'connected', accountKey: 'account-a', targetCommandId: 'old-command' })
    await expect(operation).rejects.toBeInstanceOf(WorkspaceWriteAuthError)
    expect(boundary.read).not.toHaveBeenCalled()
    expect(boundary.opportunities).not.toHaveBeenCalled()
    expect(boundary.inbox).not.toHaveBeenCalled()
    expect(boundary.replace).not.toHaveBeenCalled()
    for (const spy of semanticSpies) expect(spy).not.toHaveBeenCalled()
    expectNoMutation(before)
  })
})

async function prepareDecision() {
  current = fixture([opportunity('opp-1', 'Product Manager'), opportunity('opp-2', 'Platform Manager')])
  const candidate: SemanticCandidate = { id: 'abandon-example', kind: 'abandon_opportunity', target: { company: 'Example Co' },
    objectConfidence: 'high', eventConfidence: 'high', temporalConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }
  const result = await submitWebSemanticCapture('放弃 Example Co', { ...CAPTURE, candidates: [candidate] })
  expect(result.status).toBe('DECISION_REQUIRED')
  const request = current.data.decisionRequests!.find(item => item.id === result.decisionRequestIds[0])!
  const choice = request.choices.find(item => item.resolution?.opportunityId === 'opp-2')!
  expect(choice).toBeDefined()
  return { request, choice }
}

describe('resolved anonymous, unbound local semantic work still succeeds', () => {
  it('applies real interpreted capture atomically and Undo restores the business stage', async () => {
    const result = await submitWebSemanticCapture(TEXT, CAPTURE)
    expect(result.status).toBe('APPLIED')
    expect(current.data.opportunities[0].processStage).toBe('screening')
    expect(result.undo).toBeDefined()
    expect(commits).toBe(1)
    expect(boundary.replace.mock.calls[0][1].expectedLocal.data.opportunities[0].processStage).toBe('not_applied')
    expect(boundary.replace.mock.calls[0][1].assertCurrent).toBeTypeOf('function')
    await expect(undoWebSemanticChange(result.undo!, new Date('2026-10-08T10:01:00Z'))).resolves.toMatch(/^[a-f0-9]{64}$/)
    expect(current.data.opportunities[0].processStage).toBe('not_applied')
    expect(current.data.semanticReceipts?.[0]).toMatchObject({ status: 'undone', undoAvailable: false })
    expect(commits).toBe(2)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(boundary.execute).not.toHaveBeenCalled()
    expect(boundary.queue).not.toHaveBeenCalled()
  })

  it('creates and resolves a real local decision, then undoes its selected mutation', async () => {
    const { request, choice } = await prepareDecision()
    const result = await resolveWebDecision(request.id, choice.id, { now: NOW })
    expect(result).toMatchObject({ status: 'APPLIED', changed: true })
    expect(current.data.opportunities.find(item => item.id === 'opp-2')?.participationStatus).toBe('abandoned')
    expect(current.data.opportunities.find(item => item.id === 'opp-1')?.participationStatus).toBe('active')
    await undoWebSemanticChange(result.undo!, new Date('2026-10-08T10:01:00Z'))
    expect(current.data.opportunities.find(item => item.id === 'opp-2')?.participationStatus).toBe('active')
    expect(current.data.decisionRequests?.find(item => item.id === request.id)?.state).toBe('open')
    expect(commits).toBe(3)
    expect(boundary.execute).not.toHaveBeenCalled()
  })

  it('rejects a local Undo from before login without reading or compensating newly bound data', async () => {
    const result = await submitWebSemanticCapture(TEXT, CAPTURE)
    bindAccount()
    current.data.opportunities.push(opportunity('new-account-row', 'Engineer'))
    const before = structuredClone(current)
    clearObservations()
    await expect(undoWebSemanticChange(result.undo!, NOW)).rejects.toBeInstanceOf(WorkspaceWriteAuthError)
    expect(boundary.read).not.toHaveBeenCalled()
    expect(semanticSpies[3]).not.toHaveBeenCalled()
    expectNoMutation(before)
  })
})

describe('legacy explicit local mode retains account-bound Undo', () => {
  it('can reverse its own local write only while the same account and local mode remain active', async () => {
    boundary.authorityEnabled.mockReturnValue(false)
    bindAccount()
    const before = structuredClone(current)
    const result = await submitWebSemanticCapture(TEXT, { ...CAPTURE, accountKey: 'account-a' })
    expect(result.undo).toMatchObject({ accountKey: 'account-a' })
    expect(current.data.opportunities[0].processStage).toBe('screening')
    await undoWebSemanticChange(result.undo!, NOW)
    expect(current.data.opportunities).toHaveLength(before.data.opportunities.length)
    expect(current.data.opportunities[0]).toMatchObject({ id: before.data.opportunities[0].id, company: 'Example Co', role: 'Product Manager', processStage: 'not_applied' })
    expect(Object.values(current.data.opportunities[0].applicationSubmissionProofs ?? {})).toEqual(['withdrawn'])
    expect(boundary.execute).not.toHaveBeenCalled()
  })

  it.each([undefined, 'account-a'])('does not revive local Undo after an account ABA with identical data (original %s)', async accountKey => {
    boundary.authorityEnabled.mockReturnValue(false)
    if (accountKey) bindAccount(accountKey)
    const result = await submitWebSemanticCapture(TEXT, { ...CAPTURE, accountKey })
    const before = structuredClone(current)
    bindAccount('account-b')
    setAccountCacheSession(accountKey)
    if (accountKey) bindLocalWorkspaceToUser(accountKey)
    else clearLocalWorkspaceBinding()
    clearObservations()
    await expect(undoWebSemanticChange(result.undo!, NOW)).rejects.toBeInstanceOf(AccountCacheChangedError)
    expect(boundary.read).not.toHaveBeenCalled()
    expectNoMutation(before)
  })

  it.each(['account changed', 'transactional enabled'] as const)('rejects local account Undo after %s', async change => {
    boundary.authorityEnabled.mockReturnValue(false)
    bindAccount()
    const result = await submitWebSemanticCapture(TEXT, { ...CAPTURE, accountKey: 'account-a' })
    const before = structuredClone(current)
    if (change === 'account changed') bindAccount('account-b')
    else boundary.authorityEnabled.mockReturnValue(true)
    clearObservations()
    await expect(undoWebSemanticChange(result.undo!, NOW)).rejects.toBeInstanceOf(WorkspaceWriteAuthError)
    expect(boundary.read).not.toHaveBeenCalled()
    expectNoMutation(before)
  })
})

describe('asynchronous local mutations retain the admission lease through commit', () => {
  async function operationFor(action: 'capture' | 'decision' | 'undo') {
    if (action === 'decision') {
      const { request, choice } = await prepareDecision()
      return () => resolveWebDecision(request.id, choice.id, { now: NOW })
    }
    if (action === 'undo') {
      const result = await submitWebSemanticCapture(TEXT, CAPTURE)
      return () => undoWebSemanticChange(result.undo!, NOW)
    }
    return () => submitWebSemanticCapture(TEXT, CAPTURE)
  }

  it.each(['capture', 'decision', 'undo'] as const)('rejects %s if login begins while its initial snapshot read is pending', async action => {
    const run = await operationFor(action)
    const before = structuredClone(current)
    clearObservations()
    const entered = deferred(), release = deferred()
    boundary.read.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return structuredClone(before) })
    const pending = run()
    await entered.promise
    bindAccount()
    release.resolve()
    await expect(pending).rejects.toBeInstanceOf(AccountCacheChangedError)
    expect(boundary.replace).not.toHaveBeenCalled()
    for (const spy of semanticSpies) expect(spy).not.toHaveBeenCalled()
    expectNoMutation(before)
  })

  it('rejects a newly bound workspace during the real asynchronous SHA-256 fingerprint', async () => {
    const before = structuredClone(current)
    const entered = deferred(), release = deferred()
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle)
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
      const computed = await digest(algorithm, data)
      entered.resolve()
      await release.promise
      return computed
    })
    const pending = submitWebSemanticCapture(TEXT, CAPTURE)
    await entered.promise
    bindLocalWorkspaceToUser('account-a')
    release.resolve()
    await expect(pending).rejects.toBeInstanceOf(WorkspaceWriteAuthError)
    expect(boundary.replace).not.toHaveBeenCalled()
    for (const spy of semanticSpies) expect(spy).not.toHaveBeenCalled()
    expectNoMutation(before)
  })

  for (const interruption of ['account', 'binding', 'device', 'Auth restart', 'concurrent data'] as const) {
    it.each(['capture', 'decision', 'undo'] as const)(`rejects %s when ${interruption} changes immediately before atomic replacement commits`, async action => {
      const run = await operationFor(action)
      let expectedAfter = structuredClone(current)
      clearObservations()
      beforeCommit = () => {
        if (interruption === 'account') bindAccount()
        if (interruption === 'binding') bindLocalWorkspaceToUser('account-a')
        if (interruption === 'device') window.localStorage.setItem('pjsdas-google-drive-sync-state-v2', JSON.stringify({ ...getCloudDeviceState(), deviceId: 'replacement-device' }))
        if (interruption === 'Auth restart') beginAccountCacheSessionResolution()
        if (interruption === 'concurrent data') {
          current.data.opportunities.push(opportunity('concurrent-row', 'Engineer'))
          expectedAfter = structuredClone(current)
        }
      }
      await expect(run()).rejects.toBeInstanceOf(interruption === 'binding' ? WorkspaceWriteAuthError : AccountCacheChangedError)
      expect(boundary.replace).toHaveBeenCalledTimes(1)
      expect(boundary.replace.mock.calls[0][1].assertCurrent).toBeTypeOf('function')
      expectNoMutation(expectedAfter)
    })
  }
})

describe('explicit connected account retains the authoritative command paths', () => {
  it.each(['execute', 'confirm', 'queue'] as const)('routes connected capture through %s without local semantic application', async mode => {
    bindAccount()
    const before = structuredClone(current)
    const result = await submitWebSemanticCapture(TEXT, { ...CAPTURE, accountKey: 'account-a', confirmExisting: mode === 'confirm', queueOffline: mode === 'queue' })
    expect(result.status).toBe(mode === 'queue' ? 'QUEUED' : mode === 'confirm' ? 'ALREADY_APPLIED' : 'APPLIED')
    const selected = boundary[mode]
    expect(selected).toHaveBeenCalledTimes(1)
    if (mode === 'confirm') expect(selected).toHaveBeenCalledWith('account-a', CAPTURE.commandId)
    else expect(selected).toHaveBeenCalledWith('account-a', expect.objectContaining({ type: 'semantic_intake', value: expect.objectContaining({ originalText: TEXT }) }), { commandId: CAPTURE.commandId })
    expect(current).toEqual(before)
    expect(boundary.replace).not.toHaveBeenCalled()
    expect(semanticSpies[0]).toHaveBeenCalledTimes(1)
    expect(semanticSpies[1]).not.toHaveBeenCalled()
    expect(commits).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
    if (mode !== 'queue') expect(result.undo).toEqual({ kind: 'connected', accountKey: 'account-a', targetCommandId: CAPTURE.commandId })
  })

  it('routes connected decision and Undo through their authoritative commands', async () => {
    bindAccount()
    await resolveWebDecision('request-a', 'choice-a', { accountKey: 'account-a', now: NOW })
    expect(boundary.execute).toHaveBeenCalledWith('account-a', { type: 'resolve_semantic_decision', value: { requestId: 'request-a', choiceId: 'choice-a' } }, { commandId: 'connected-command-1' })
    await undoWebSemanticChange({ kind: 'connected', accountKey: 'account-a', targetCommandId: 'command-a' }, NOW)
    expect(boundary.undo).toHaveBeenCalledWith('account-a', 'command-a')
    expect(boundary.read).not.toHaveBeenCalled()
    expect(boundary.replace).not.toHaveBeenCalled()
    expect(semanticSpies[2]).not.toHaveBeenCalled()
    expect(semanticSpies[3]).not.toHaveBeenCalled()
    expect(commits).toBe(0)
  })

  it('rejects A → B → A during capture preparation before queueing or sending any command', async () => {
    bindAccount()
    const before = structuredClone(current)
    const entered = deferred(), release = deferred()
    boundary.read.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return structuredClone(before) })
    const pending = submitWebSemanticCapture(TEXT, { ...CAPTURE, accountKey: 'account-a', queueOffline: true })
    await entered.promise
    setAccountCacheSession('account-b')
    setAccountCacheSession('account-a')
    release.resolve()
    await expect(pending).rejects.toBeInstanceOf(AccountCacheChangedError)
    expectNoMutation(before)
  })
})
