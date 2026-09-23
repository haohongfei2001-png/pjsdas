/**
 * CGR-02 production command canary. No network or write occurs without --execute.
 * Uses two separately authenticated sessions of the same synthetic test account.
 * Never prints tokens, snapshot bodies, recruiting data or raw API responses.
 */
import { randomUUID } from 'node:crypto'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'

type AuthSession = { token: string; subject: string }
type WorkspaceReply = {
  revision: number
  snapshot: PJSDASSnapshot
  outcome?: string
  receipt?: Record<string, unknown>
  found?: boolean
  result?: Record<string, unknown>
}

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}; canary did not start.`)
  return value
}

function subjectOf(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { sub?: string; exp?: number }
    if (!payload.sub || !payload.exp || payload.exp * 1000 <= Date.now() + 120_000) throw new Error('expired')
    return payload.sub
  } catch {
    throw new Error('Canary requires a valid, unexpired account access token; no write was attempted.')
  }
}

function session(name: string): AuthSession {
  const token = required(name)
  return { token, subject: subjectOf(token) }
}

function marker() {
  return `CGR02 验证 ${randomUUID().slice(0, 8)}`
}

function observation(title: string, baseline: PJSDASSnapshot) {
  const text = `事项：${title}`
  const parsed = buildWebSemanticInterpretation(text, baseline.data.opportunities, baseline, [], new Date())
  if (parsed.mode !== 'assertion' || parsed.candidates.length !== 1 || parsed.candidates[0]?.kind !== 'manual_action'
    || parsed.candidates[0].title !== title || parsed.unresolved.length) {
    throw new Error('The frozen manual-action interpretation no longer matches this canary; no write was attempted.')
  }
  const id = randomUUID()
  const now = new Date().toISOString()
  return {
    type: 'semantic_intake' as const,
    value: {
      contractVersion: 1 as const,
      inputId: `cgr02-canary:${id}`,
      source: {
        kind: 'web' as const,
        sourceId: 'todayaction-web',
        sourceRecordId: `cgr02-canary:${id}`,
        sourceVersion: '1',
        observedAt: now,
        assertedAt: now,
        timezone: 'UTC',
      },
      statementMode: parsed.mode,
      originalText: text,
      contextRefs: [],
      candidates: parsed.candidates,
    },
  }
}

async function json(url: string, options: RequestInit) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12_000) })
  const data = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
  if (!response.ok || !data) throw new Error(`Production canary HTTP ${response.status}; details withheld.`)
  return data
}

function workspaceReply(data: Record<string, unknown>): WorkspaceReply {
  if (!Number.isInteger(data.revision) || !data.snapshot) throw new Error('Production workspace reply is incomplete.')
  validateSnapshot(data.snapshot)
  return data as WorkspaceReply
}

async function workspace(origin: string, auth: AuthSession, body: Record<string, unknown>) {
  return workspaceReply(await json(`${origin}/api/workspace`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

function hasTitle(reply: WorkspaceReply, title: string) {
  return reply.snapshot.data.actions.some((item) => item.title === title)
}

async function committedOrRecovered(origin: string, auth: AuthSession, commandId: string, body: Record<string, unknown>) {
  try {
    const result = await workspace(origin, auth, body)
    if (!['COMMITTED', 'ALREADY_APPLIED'].includes(result.outcome ?? '')) throw new Error('Command did not commit.')
    return result
  } catch {
    const receipt = await workspace(origin, auth, { action: 'receipt', commandId })
    if (!receipt.found || receipt.receipt?.commandId !== commandId) {
      throw new Error(`UNKNOWN_COMMAND_OUTCOME for ${commandId}; no retry or new identity was issued.`)
    }
    return receipt
  }
}

async function undo(origin: string, auth: AuthSession, targetCommandId: string, commandId: string) {
  return committedOrRecovered(origin, auth, commandId, { action: 'undo', commandId, targetCommandId })
}

async function run() {
  if (process.argv.includes('--plan')) {
    const empty = upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1,
      exportedAt: new Date().toISOString(),
      data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], semanticReceipts: [], timeline: [] } })
    observation('CGR02 验证 plan', empty)
    console.log('CGR-02 canary plan valid: exact SHA + two same-account sessions -> read -> two synthetic authoritative commands -> cross-client visibility <=15s -> receipt -> undo first after second -> undo second -> empty cleanup. No network or write occurred.')
    return
  }
  if (!process.argv.includes('--execute')) throw new Error('Use --plan or --execute; no network or write occurred.')

  const origin = new URL(required('PJSDAS_CGR02_CANARY_ORIGIN'))
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Canary origin must be an HTTPS API origin.')
  const expectedSha = required('PJSDAS_EXPECTED_COMMIT_SHA').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('Expected exact integrated SHA is invalid.')
  const clientA = session('PJSDAS_CGR02_CANARY_ACCESS_TOKEN_A')
  const clientB = session('PJSDAS_CGR02_CANARY_ACCESS_TOKEN_B')
  if (clientA.subject !== clientB.subject || clientA.token === clientB.token) throw new Error('Two distinct sessions of the same test account are required.')

  const health = await json(`${origin.origin}/api/health`, { headers: { accept: 'application/json' } })
  const release = health.release as Record<string, unknown> | undefined
  if (release?.commitSha !== expectedSha || health.workspaceAuthority !== 'transactional') {
    throw new Error('Production health does not match the exact integrated SHA and transactional authority; no write was attempted.')
  }

  const firstTitle = marker()
  const secondTitle = marker()
  const attempted: string[] = []
  const committed: string[] = []
  const undone = new Set<string>()
  const undoIds = new Map<string, string>()
  let visibilityMs: number | undefined
  try {
    let state = await workspace(origin.origin, clientA, { action: 'read' })
    for (const title of [firstTitle, secondTitle]) {
      const commandId = `cgr02-canary:${randomUUID()}`
      const command = observation(title, state.snapshot)
      const started = title === firstTitle ? Date.now() : undefined
      attempted.push(commandId)
      state = await committedOrRecovered(origin.origin, clientA, commandId, {
        action: 'command', commandId, baseRevision: state.revision, command,
      })
      committed.push(commandId)
      if (!hasTitle(state, title)) throw new Error('The committed action is absent from the authoritative reply.')
      if (title === firstTitle) {
        while (Date.now() - started! < 15_000) {
          const other = await workspace(origin.origin, clientB, { action: 'read' })
          if (hasTitle(other, firstTitle)) { visibilityMs = Date.now() - started!; break }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        if (visibilityMs === undefined) throw new Error('Cross-client visibility exceeded the frozen 15-second target.')
      }
      const receipt = await workspace(origin.origin, clientB, { action: 'receipt', commandId })
      if (!receipt.found || receipt.receipt?.commandId !== commandId) throw new Error('The durable command receipt is missing.')
    }
    const firstUndoId = `cgr02-canary-undo:${randomUUID()}`
    undoIds.set(committed[0]!, firstUndoId)
    await undo(origin.origin, clientA, committed[0]!, firstUndoId)
    undone.add(committed[0]!)
    state = await workspace(origin.origin, clientB, { action: 'read' })
    if (hasTitle(state, firstTitle) || !hasTitle(state, secondTitle)) {
      throw new Error('Undo did not preserve the unrelated later synthetic update.')
    }
  } finally {
    for (const commandId of attempted.toReversed()) {
      if (undone.has(commandId)) continue
      const lookup = await workspace(origin.origin, clientA, { action: 'receipt', commandId })
      if (!lookup.found) continue
      const previousUndoId = undoIds.get(commandId)
      if (previousUndoId) {
        const previousUndo = await workspace(origin.origin, clientA, { action: 'receipt', commandId: previousUndoId })
        if (!previousUndo.found) throw new Error(`UNKNOWN_UNDO_OUTCOME for ${previousUndoId}; no new undo identity was issued.`)
        undone.add(commandId)
        continue
      }
      const undoId = `cgr02-canary-undo:${randomUUID()}`
      undoIds.set(commandId, undoId)
      await undo(origin.origin, clientA, commandId, undoId)
      undone.add(commandId)
    }
    if (attempted.length) {
      const finalState = await workspace(origin.origin, clientB, { action: 'read' })
      if (hasTitle(finalState, firstTitle) || hasTitle(finalState, secondTitle)) {
        throw new Error('Canary cleanup is incomplete; retain command IDs for controlled recovery.')
      }
    }
  }
  console.log(JSON.stringify({ result: 'PASS', exactSha: expectedSha, visibilityMs,
    commandCount: committed.length, receiptCount: committed.length, undoCount: undone.size,
    cleanup: 'verified', account: 'redacted', content: 'synthetic-only' }))
}

await run()
