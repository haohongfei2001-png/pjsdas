/** Synthetic component integration harness. Never a production backend. */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

const PREFIX = 'ta-stop-browser-harness:'
const OWNERSHIP = PREFIX + 'owned-origin-v1'
function assertHarnessOrigin() {
  if (location.origin !== 'http://127.0.0.1:4187' || import.meta.env.VITE_PJSDAS_CLOUD_MODE !== 'mock'
    || import.meta.env.VITE_PJSDAS_CONNECTED_AUTHORITY !== 'transactional') throw Error('SYNTHETIC_HARNESS_WRONG_ORIGIN_OR_MODE: no storage was read or changed')
}
assertHarnessOrigin()
// This runs before importing db.ts, which opens IndexedDB at module evaluation.
// An anonymous existing workspace is protected even if localStorage is empty.
if (typeof indexedDB.databases !== 'function') throw Error('SYNTHETIC_HARNESS_CANNOT_VERIFY_EMPTY_ORIGIN')
const existingDatabases = await indexedDB.databases()
if (localStorage.getItem(OWNERSHIP) !== 'stop-browser-harness-v1') {
  if (localStorage.length || existingDatabases.length) throw Error('SYNTHETIC_HARNESS_REFUSES_EXISTING_ORIGIN_DATA')
  localStorage.setItem(OWNERSHIP, 'stop-browser-harness-v1')
}
if (existingDatabases.some(db => db.name !== 'pjsdas')) throw Error('SYNTHETIC_HARNESS_REFUSES_UNRELATED_DATABASE')
// Only after the exact origin and untouched-origin proof may real product modules load.
const { default: OpportunityDetailDrawer } = await import('../../src/OpportunityDetailDrawer.js')
const { UiLanguageProvider } = await import('../../src/uiLanguage.js')
const { createSnapshot, upgradeSnapshotToLatest } = await import('../../src/snapshot.js')
const { applyUserDomainCommand, applyDomainCompensation } = await import('../../src/domainCommands.js')
const { exportLocalSnapshot, replaceLocalSnapshotFromCloud, clearLocalWorkspaceCache } = await import('../../src/db.js')
const { setAccountCacheSession } = await import('../../src/cloud/accountCacheLease.js')
const { bindLocalWorkspaceToUser, clearLocalWorkspaceBinding, patchAccountCheckpoint } = await import('../../src/cloud/syncState.js')
const { fingerprintWorkspace } = await import('../../src/cloud/workspaceFingerprint.js')
const { listAccountPendingOperations, readAccountDraft } = await import('../../src/cloud/authoritativeCommandClient.js')
const { MOCK_AUTH_STORAGE_KEY, MOCK_AUTH_ORIGIN, MOCK_BACKEND_ORIGIN } = await import('../../src/cloud/runtimeCloudMode.js')
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222'
const JOB = 'synthetic-browser-job'
const key = (suffix: string) => PREFIX + suffix
const get = (suffix: string, fallback: any = null) => JSON.parse(localStorage.getItem(key(suffix)) ?? JSON.stringify(fallback))
const put = (suffix: string, value: any) => localStorage.setItem(key(suffix), JSON.stringify(value))
const errors: string[] = []
const readDiagnostics: Array<{ action: string; at: string }> = []
let receiptInflight = 0
let scenarioGeneration = 0
let setupInFlight = false
let setupFailure = ''
let onObserve: (() => void) | undefined
let holdNext = false
let releaseHeld: (() => void) | undefined
let held = false
let viewAccount = get('account', A) as string
let localMode = get('localMode', false) as boolean
// A per-request key cannot lose evidence through a cross-tab read/modify/write race.
const transport = () => Object.keys(localStorage).filter(k => k.startsWith(key('request:'))).map(k => JSON.parse(localStorage.getItem(k)!)).sort((a, b) => a.at.localeCompare(b.at))
const log = (entry: any) => {
  const at = new Date().toISOString()
  if (['command', 'undo'].includes(entry.action)) put('request:' + crypto.randomUUID(), { ...entry, at })
  else readDiagnostics.push({ action: entry.action, at })
  // Receipt/auth/read diagnostics never emit storage events to peer controls.
  onObserve?.()
}
function initialSnapshot(governed = false) {
  const at = '2030-01-01T00:00:00.000Z'
  return createSnapshot({ opportunities: [{ id: JOB, company: 'Synthetic Browser Company', role: 'Analyst', currentStageLabel: 'screening', processStage: 'screening', roleType: 'core', early: false, opportunityValue: 50, fitScore: 50, participationStatus: 'active', locallyManaged: true, importedAt: at, ...(governed ? { applicationGroupId: 'shared-synthetic' } : {}) }],
    processes: [], processEvents: [], actions: Array.from({ length: 2 }, (_, i) => ({ id: 'browser-action-' + i, kind: 'follow_up' as const, title: 'Synthetic follow-up ' + i, opportunityId: JOB, estimatedMinutes: 10, leverage: 50, delayCost: 50, status: 'todo' as const, createdAt: at, updatedAt: at })), prep: [],
    applicationGroups: governed ? [{ id: 'shared-synthetic', name: 'Synthetic shared rules', locked: true, total: 2, remaining: 2, rule: 'Review shared participation first' } as any] : [], timeline: [] }, at)
}
function encode(value: any) { return btoa(unescape(encodeURIComponent(JSON.stringify(value)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }
function authSession(account: string) {
  const exp = Math.floor(Date.now() / 1000) + 86400
  const claims = { sub: account, role: 'authenticated', aud: 'authenticated', iss: MOCK_AUTH_ORIGIN + '/auth/v1', exp }
  const token = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode(claims) + '.synthetic-signature'
  return { access_token: token, token_type: 'bearer', expires_in: 86400, expires_at: exp, refresh_token: 'synthetic-not-usable', user: { id: account, aud: 'authenticated', role: 'authenticated', email: account + '@example.invalid', app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: { sub: account, full_name: 'Synthetic browser owner' }, identities: [], created_at: '2030-01-01T00:00:00Z', is_anonymous: false } }
}
function accountFrom(init?: RequestInit) {
  const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
  const claims = JSON.parse(atob(token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/')))
  if (![A, B].includes(claims.sub)) throw Error('Harness rejects non-synthetic account')
  return claims.sub as string
}
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  if (url.origin === location.origin) return nativeFetch(input, init)
  if (url.origin === MOCK_AUTH_ORIGIN) {
    const account = accountFrom(init); log({ action: 'synthetic-auth-user', account })
    return Response.json(authSession(account).user)
  }
  if (url.origin !== MOCK_BACKEND_ORIGIN) { errors.push('blocked non-synthetic request: ' + url.origin); throw Error('Harness forbids external requests') }
  if (url.pathname === '/api/health') return Response.json({ status: 'ok', version: '1.10.0-alpha.1', mode: 'transactional-connected', workspaceAuthority: 'transactional', capabilities: { deploymentPortability: true } })
  if (url.pathname !== '/api/workspace') throw Error('Unexpected synthetic route')
  const account = accountFrom(init), body = JSON.parse(String(init?.body))
  log({ action: body.action, account, commandId: body.commandId ?? null, targetCommandId: body.targetCommandId ?? null })
  const isReceipt = body.action === 'receipt'
  if (isReceipt) receiptInflight += 1
  try {
  if (holdNext && ['command', 'undo'].includes(body.action)) {
    holdNext = false; held = true; onObserve?.()
    await new Promise<void>(resolve => { releaseHeld = resolve })
    held = false; releaseHeld = undefined
  }
  // Storage is shared across tabs. The product's native Web Lock is responsible
  // for serializing its own same-account/job commands; no harness lock is added.
  const server = get('server:' + account)
  if (!server) throw Error('Synthetic account is not initialized')
  const answer = (extra: any = {}) => ({ revision: server.revision, workspaceVersion: 'txn:' + server.revision, workspaceId: 'synthetic-' + account, schemaVersion: 4, snapshot: server.snapshot, ...extra })
  if (body.action === 'read') return Response.json(answer())
  if (body.action === 'receipt') return Response.json(server.receipts[body.commandId] ? answer({ ...server.receipts[body.commandId], found: true }) : { found: false })
  if (server.receipts[body.commandId]) return Response.json(answer({ ...server.receipts[body.commandId], outcome: 'ALREADY_APPLIED' }))
  if (body.action === 'command') {
    if (body.command?.type !== 'domain' || body.command.value.kind !== 'abandon_opportunity' || body.command.value.opportunityId !== JOB) throw Error('Unexpected synthetic command')
    const command = { commandId: String(body.commandId), kind: 'abandon_opportunity' as const, opportunityId: JOB }
    const result = applyUserDomainCommand(server.snapshot, command, new Date())
    if (result.status !== 'APPLIED' || !result.compensation) throw Error('Expected a domain application')
    server.snapshot = upgradeSnapshotToLatest(result.snapshot); server.compensations[body.commandId] = result.compensation
  } else if (body.action === 'undo') {
    if (!server.compensations[body.targetCommandId]) throw Error('Unknown original compensation')
    server.snapshot = upgradeSnapshotToLatest(applyDomainCompensation(server.snapshot, server.compensations[body.targetCommandId], new Date()))
  } else throw Error('Unsupported synthetic action')
  server.revision += 1
  const receipt = { contractVersion: 5, commandId: body.commandId, status: 'COMMITTED', operation: body.action === 'undo' ? 'undo_command' : 'domain:abandon_opportunity', affectedObjects: [{ type: 'opportunity', id: JOB }], undoAvailable: body.action !== 'undo', revision: server.revision, ...(body.action === 'undo' ? { undoOf: body.targetCommandId } : {}) }
  server.receipts[body.commandId] = { outcome: 'COMMITTED', receipt }
  put('server:' + account, server); onObserve?.()
  return Response.json(answer(server.receipts[body.commandId]))
  } finally { if (isReceipt) receiptInflight -= 1 }
}
window.addEventListener('error', event => { errors.push(event.message); onObserve?.() })
window.addEventListener('unhandledrejection', event => { errors.push(String(event.reason)); onObserve?.() })

async function bind(account: string, mode: boolean, replace: boolean) {
  // Synthetic identity setup only; no command/receipt/outbox is inserted.
  setAccountCacheSession(mode ? undefined : account)
  viewAccount = account; localMode = mode; put('account', account); put('localMode', mode)
  if (mode) { clearLocalWorkspaceBinding(); localStorage.removeItem(MOCK_AUTH_STORAGE_KEY) }
  else { localStorage.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(authSession(account))); bindLocalWorkspaceToUser(account) }
  if (replace) await replaceLocalSnapshotFromCloud(get('server:' + account).snapshot)
  if (!mode) {
    const snapshot = await exportLocalSnapshot(), fingerprint = await fingerprintWorkspace(snapshot)
    patchAccountCheckpoint(account, { lastSyncedVersion: 'txn:' + get('server:' + account).revision, lastSyncedFingerprint: fingerprint, lastReadProjectionFingerprint: fingerprint, lastReadProjectionSourceFingerprint: fingerprint })
  }
}
async function reset(mode: boolean, governed = false) {
  assertHarnessOrigin()
  if (localStorage.getItem(OWNERSHIP) !== 'stop-browser-harness-v1') throw Error('SYNTHETIC_HARNESS_LOST_OWNERSHIP_MARKER')
  const ownedKey = (key: string) => key.startsWith(PREFIX) || ['pjsdas-ui-language', MOCK_AUTH_STORAGE_KEY, 'pjsdas-google-drive-sync-state-v2', 'todayaction-mock-cache-provenance-v1'].includes(key) || [A, B].some(account => key === 'pjsdas-cgr01-pending:' + account || key.startsWith('pjsdas-cgr01-draft:' + account + ':'))
  if (Object.keys(localStorage).some(key => !ownedKey(key)) || (await indexedDB.databases()).some(db => db.name !== 'pjsdas')) throw Error('SYNTHETIC_HARNESS_REFUSES_UNRELATED_STORAGE')
  const binding = JSON.parse(localStorage.getItem('pjsdas-google-drive-sync-state-v2') ?? '{}')
  if (binding.workspaceOwnerUserId && ![A, B].includes(binding.workspaceOwnerUserId)) throw Error('SYNTHETIC_HARNESS_REFUSES_FOREIGN_OWNER')
  const auth = JSON.parse(localStorage.getItem(MOCK_AUTH_STORAGE_KEY) ?? 'null')
  if (auth?.user?.id && ![A, B].includes(auth.user.id)) throw Error('SYNTHETIC_HARNESS_REFUSES_FOREIGN_AUTH')
  if (held) throw Error('Release the held request before resetting')
  // Dedicated localhost origin/port only. There is no user's production storage.
  for (const name of Object.keys(localStorage)) if (name !== OWNERSHIP) localStorage.removeItem(name)
  errors.length = 0; readDiagnostics.length = 0; holdNext = false
  for (const account of [A, B]) put('server:' + account, { snapshot: initialSnapshot(governed), revision: 0, receipts: {}, compensations: {} })
  put('governed', governed)
  setAccountCacheSession(undefined); clearLocalWorkspaceBinding(); await clearLocalWorkspaceCache()
  await bind(A, mode, true)
}
if (!get('server:' + A)) await reset(false)
else await bind(viewAccount, localMode, false)

function Harness() {
  const [snapshot, setSnapshot] = useState<any>(), [observations, setObservations] = useState<any>({}), [account, setAccount] = useState(viewAccount)
  const [mode, setMode] = useState(localMode), [open, setOpen] = useState(location.hash === '#detail')
  const [blocked, setBlocked] = useState(false), [readOnly, setReadOnly] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  async function observe() {
    const current = await exportLocalSnapshot(); setSnapshot(current)
    const server = get('server:' + viewAccount), requests = transport()
    const locks = await navigator.locks.query(), exactLock = `todayaction:stop-following:${viewAccount}\u0000${JOB}`
    const nativeLockHeld = locks.held?.filter(lock => lock.name === exactLock).length ?? 0
    const nativeLockPending = locks.pending?.filter(lock => lock.name === exactLock).length ?? 0
    const localLocator = readAccountDraft(viewAccount, 'stop-following:' + JOB)
    setObservations({ boundary: 'real asPage job-detail component + native IDB/Web Locks; synthetic full-snapshot HTTP projection, NOT exact delta-v1 API/AppV8/PostgreSQL', nativeIndexedDB: Object.prototype.toString.call(indexedDB), nativeLocks: Object.prototype.toString.call(navigator.locks), mode: localMode ? 'local-only' : 'connected-synthetic', account: viewAccount === A ? 'A' : 'B', held, holdNext, nativeLockHeld, nativeLockPending, scenarioGeneration, setupInFlight, setupFailure, sharedGovernance: current.data.applicationGroups.some(group => group.id === 'shared-synthetic' && group.locked === true),
      localParticipation: current.data.opportunities.find((x: any) => x.id === JOB)?.participationStatus, localActionStates: current.data.actions.map((x: any) => x.status), serverRevision: server.revision,
      serverParticipation: server.snapshot.data.opportunities[0]?.participationStatus, committedCommands: Object.keys(server.receipts), allWrites: requests.filter((x: any) => ['command', 'undo'].includes(x.action)), receiptReads: readDiagnostics.filter(x => x.action === 'receipt').length, receiptInflight,
      pending: listAccountPendingOperations(viewAccount).map(x => ({ action: x.action, status: x.status, commandId: x.commandId, targetCommandId: x.targetCommandId })), locator: localLocator ? JSON.parse(localLocator) : null, errors })
  }
  useEffect(() => { onObserve = () => { void observe() }; const poll = setInterval(() => { void observe() }, 500); const pop = () => setOpen(location.hash === '#detail'); window.addEventListener('popstate', pop); window.addEventListener('storage', onObserve); void observe(); return () => { clearInterval(poll); window.removeEventListener('popstate', pop); window.removeEventListener('storage', onObserve!); onObserve = undefined } }, [])
  const close = () => { history.pushState({}, '', location.pathname); setOpen(false) }
  async function setup(mode: boolean, governed = false) {
    setupInFlight = true; setupFailure = ''; setBusy(true); setOpen(false)
    try {
      await reset(mode, governed); setMode(mode); setAccount(A); setBlocked(false); setReadOnly(false)
      scenarioGeneration += 1; setNotice('Synthetic scenario reset; no command seeded.')
    } catch (error) { setupFailure = String(error); setNotice(setupFailure) }
    finally { setupInFlight = false; setBusy(false); await observe() }
  }
  async function changeAccount(next: string) { setBusy(true); setAccountCacheSession(mode ? undefined : next); setAccount(next); try { await bind(next, mode, true); setNotice('Synthetic account boundary applied.'); await observe() } catch (error) { setNotice(String(error)) } finally { setBusy(false) } }
  const opportunity = snapshot?.data.opportunities.find((x: any) => x.id === JOB)
  return <><header className="harness-header"><h1>Synthetic stop-following browser harness</h1><p><strong>Exact product component; synthetic identity/full-snapshot backend. Not exact delta-v1 API, full AppV8, or PG acceptance. Dedicated guarded test origin only.</strong></p>
    <div className="controls"><button disabled={busy} onClick={() => void setup(false)}>Reset connected synthetic</button><button disabled={busy} onClick={() => void setup(true)}>Reset local-only</button><button disabled={busy} onClick={() => void setup(false, true)}>Reset shared governance</button>
      <button disabled={busy} onClick={() => { history.pushState({}, '', '#detail'); setOpen(true) }}>Open actual job page</button>
      <button disabled={busy} onClick={() => { holdNext = true; void observe() }}>Hold next command before synthetic commit</button><button onClick={() => { releaseHeld?.(); void observe() }}>Release held request</button>
      <button disabled={busy} onClick={() => void changeAccount(A)}>Use account A</button><button disabled={busy} onClick={() => void changeAccount(B)}>Use account B</button>
      <button onClick={() => setBlocked(x => !x)}>Toggle write blocked ({String(blocked)})</button><button onClick={() => setReadOnly(x => !x)}>Toggle read only ({String(readOnly)})</button><button onClick={() => void observe()}>Refresh observations</button></div>
    <p role="status">{notice}</p><p>Scenario account: {account === A ? 'A' : 'B'} · {mode ? 'local-only' : 'connected synthetic'} · no clock mocking</p></header>
    {open && opportunity && <OpportunityDetailDrawer asPage key={account + ':' + mode} opportunity={opportunity} actions={snapshot.data.actions} applicationGroup={snapshot.data.applicationGroups[0]} decisionRequests={snapshot.data.decisionRequests ?? []} timeline={snapshot.data.timeline ?? []} accountKey={mode ? undefined : account} writeBlocked={blocked || busy} readOnly={readOnly} onClose={close} onCapture={() => setNotice('Tell callback reached; no command submitted by the synthetic parent.')} onNavigate={close} onOpenDecision={() => setNotice('Decision callback reached.')} onMarkAction={async () => { throw Error('Out of scope task action') }} onStopFollowingChanged={observe} />}
    <main className="harness-observations"><section><h2>Sanitized observations</h2><pre data-testid="observations">{JSON.stringify(observations, null, 2)}</pre></section></main>
  </>
}
createRoot(document.getElementById('root')!).render(<UiLanguageProvider><Harness /></UiLanguageProvider>)
