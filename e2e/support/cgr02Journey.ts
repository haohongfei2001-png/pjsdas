import { MOCK_TARGET_AUTH_KEY, MOCK_TARGET_BACKEND } from './mockCloudTargets.js'
import { expect, type Page, type Route } from '@playwright/test'
import { upgradeSnapshotToLatest } from '../../src/snapshot.js'
import { freezeTodayFixture } from './consumerFixtureClock.js'

const BACKEND = MOCK_TARGET_BACKEND
const AUTH_KEY = MOCK_TARGET_AUTH_KEY

function reply(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

/** Wait for the initial fixture's durable account projection, without repairing it. */
export async function waitForJourneyReady(page: Page) {
  await expect.poll(() => page.evaluate(async () => {
    const key = 'pjsdas-google-drive-sync-state-v2'
    const before = localStorage.getItem(key)
    const device = JSON.parse(before ?? '{}') as {
      workspaceOwnerUserId?: string
      accounts?: Record<string, {
        lastSyncedVersion?: string
        lastSyncedFingerprint?: string
        lastReadProjectionFingerprint?: string
        lastReadProjectionSourceFingerprint?: string
      }>
    }
    const checkpoint = device.accounts?.['voiceover-account']
    const binding = {
      owner: device.workspaceOwnerUserId,
      version: checkpoint?.lastSyncedVersion,
      fingerprintRecorded: Boolean(checkpoint?.lastSyncedFingerprint && checkpoint.lastReadProjectionFingerprint
        && checkpoint.lastReadProjectionSourceFingerprint === checkpoint.lastSyncedFingerprint),
    }
    if (binding.owner !== 'voiceover-account' || binding.version !== 'txn:1' || !binding.fingerprintRecorded) return binding
    // Opening an absent database would create it. Check first, then abort an
    // upgrade if deletion races this read; fixture readiness must never write.
    if (!(await indexedDB.databases()).some(database => database.name === 'pjsdas')) return { ...binding, database: 'missing' }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pjsdas')
      let blocked = false
      request.onupgradeneeded = () => request.transaction?.abort()
      request.onerror = () => reject(request.error)
      request.onblocked = () => { blocked = true; reject(new Error('Fixture database read is blocked.')) }
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result) }
    })
    try {
      const stores = ['meta', 'actions', 'scheduleNodes', 'opportunities']
      if (stores.some(store => !database.objectStoreNames.contains(store))) return { ...binding, database: 'incomplete' }
      const tx = database.transaction(stores, 'readonly')
      const read = (store: string, id: string) => new Promise<any>((resolve, reject) => {
        const request = tx.objectStore(store).get(id)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const complete = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error ?? new Error('Fixture database read aborted.'))
        tx.onerror = () => reject(tx.error)
      })
      const [projection, action, node, opportunity] = await Promise.all([
        read('meta', 'authoritativeProjection'), read('actions', 'voiceover-action'),
        read('scheduleNodes', 'voiceover-node'), read('opportunities', 'voiceover-opportunity'), complete,
      ])
      // meta stores the projection object directly, not a { value } wrapper.
      const recorded = projection?.canonical ? JSON.parse(projection.canonical) : undefined
      const actionFacts = (row: any) => row && ({ id: row.id, title: row.title, plannedDate: row.plannedDate, status: row.status })
      const nodeFacts = (row: any) => row && ({ id: row.id, occurrenceId: row.occurrenceId, version: row.version,
        state: row.state, date: row.temporal?.date, opportunityId: row.opportunityId })
      const opportunityFacts = (row: any) => row && ({ id: row.id, company: row.company, role: row.role })
      return {
        ...binding,
        checkpointStable: before === localStorage.getItem(key),
        projection: { key: projection?.key, accountKey: projection?.accountKey, version: projection?.version },
        action: actionFacts(action), node: nodeFacts(node), opportunity: opportunityFacts(opportunity),
        recordedAction: actionFacts(recorded?.actions?.find((row: any) => row.id === 'voiceover-action')),
        recordedNode: nodeFacts(recorded?.scheduleNodes?.find((row: any) => row.id === 'voiceover-node')),
        recordedOpportunity: opportunityFacts(recorded?.opportunities?.find((row: any) => row.id === 'voiceover-opportunity')),
      }
    } finally { database.close() }
  }), { message: 'Initial VoiceOver fixture must be durably projected for its account', timeout: 30_000, intervals: [100, 250, 500] }).toMatchObject({
    owner: 'voiceover-account', version: 'txn:1', fingerprintRecorded: true, checkpointStable: true,
    projection: { key: 'authoritativeProjection', accountKey: 'voiceover-account', version: 'txn:1' },
    ...Object.fromEntries(['action', 'recordedAction'].map(key => [key, {
      id: 'voiceover-action', title: 'A第一任务', plannedDate: '2026-09-30', status: 'todo',
    }])),
    ...Object.fromEntries(['node', 'recordedNode'].map(key => [key, {
      id: 'voiceover-node', occurrenceId: 'voiceover-occurrence', version: 1, state: 'scheduled',
      date: '2026-10-20', opportunityId: 'voiceover-opportunity',
    }])),
    ...Object.fromEntries(['opportunity', 'recordedOpportunity'].map(key => [key, {
      id: 'voiceover-opportunity', company: '合成机会科技', role: 'AI产品经理',
    }])),
  })
}

export async function prepareJourney(page: Page) {
  await freezeTodayFixture(page)
  const token = 'voiceover-synthetic-token'
  await page.context().addInitScript(({ key, session }) => {
    localStorage.setItem(key, JSON.stringify(session))
  }, {
    key: AUTH_KEY,
    session: {
      access_token: token,
      token_type: 'bearer',
      expires_in: 31_536_000,
      expires_at: Math.floor(Date.now() / 1000) + 31_536_000,
      refresh_token: `refresh-${token}`,
      user: {
        id: 'voiceover-account', aud: 'authenticated', role: 'authenticated',
        email: 'voiceover@example.test', email_confirmed_at: '2026-09-23T00:00:00.000Z',
        phone: '', confirmed_at: '2026-09-23T00:00:00.000Z',
        last_sign_in_at: '2026-09-23T00:00:00.000Z',
        app_metadata: { provider: 'google', providers: ['google'] },
        user_metadata: { sub: 'voiceover-account' }, identities: [],
        created_at: '2026-09-23T00:00:00.000Z', updated_at: '2026-09-23T00:00:00.000Z',
        is_anonymous: false,
      },
    },
  })

  const snapshot = upgradeSnapshotToLatest({
    schema: 'pjsdas-local-snapshot', version: 1,
    exportedAt: '2026-09-23T00:00:00.000Z',
    data: {
      opportunities: [{
        id: 'voiceover-opportunity', company: '合成机会科技', role: 'AI产品经理',
        currentStageLabel: '面试', processStage: 'interview', roleType: 'core',
        participationStatus: 'active', early: false, opportunityValue: 88, fitScore: 86,
        importedAt: '2026-09-22T00:00:00.000Z',
      }], processes: [], processEvents: [], prep: [], applicationGroups: [],
      semanticReceipts: [], timeline: [],
      scheduleNodes: [{
        id: 'voiceover-node', occurrenceId: 'voiceover-occurrence', version: 1,
        opportunityId: 'voiceover-opportunity', kind: 'interview' as const,
        state: 'scheduled' as const, constraintKind: 'employer_hard' as const,
        temporal: { shape: 'date_only' as const, precision: 'date' as const,
          timezone: 'Asia/Shanghai', date: '2026-10-20', resolutionBasis: 'source_explicit' as const },
        evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
        createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
      }],
      actions: [{
        id: 'voiceover-action', kind: 'manual' as const, title: 'A第一任务', plannedDate: '2026-09-30',
        estimatedMinutes: 20, leverage: 80, delayCost: 80, status: 'todo' as const,
        createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
      }],
    },
  })
  let revision = 1
  let commandCount = 0
  await page.route(`${BACKEND}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return reply(route, {}, 204)
    if (url.pathname === '/api/health') {
      return reply(route, {
        status: 'ok', version: '1.10.0-alpha.1', mode: 'transactional-connected',
        workspaceAuthority: 'transactional', capabilities: { deploymentPortability: true },
      })
    }
    if (url.pathname !== '/api/workspace') return reply(route, { code: 'NOT_FOUND' }, 404)
    const body = request.postDataJSON() as Record<string, any>
    const state = () => ({ revision, workspaceVersion: `txn:${revision}`, schemaVersion: snapshot.version, snapshot })
    if (body.action === 'read') return reply(route, { workspaceId: 'voiceover-workspace', ...state() })
    if (body.action === 'command' && body.command?.type === 'semantic_intake') {
      commandCount += 1
      const title = body.command.value.candidates?.find((item: any) => item.kind === 'manual_action')?.title ?? '整理面试材料'
      snapshot.data.actions.push({
        id: 'captured-action', kind: 'manual' as const, title, plannedDate: '2026-09-30', estimatedMinutes: 20,
        leverage: 90, delayCost: 90, status: 'todo' as const,
        createdAt: '2026-09-23T05:10:00.000Z', updatedAt: '2026-09-23T05:10:00.000Z',
      })
      revision += 1
      return reply(route, {
        ...state(), outcome: 'COMMITTED',
        receipt: {
          commandId: body.commandId, receiptId: `receipt:${body.commandId}`,
          status: 'COMMITTED', revision, undoAvailable: true,
          affectedObjects: [{ type: 'action', id: 'captured-action' }],
          result: { type: 'semantic_intake', status: 'APPLIED', summary: `已记录：${title}`, decisionRequestIds: [] },
        },
        result: { type: 'semantic_intake', status: 'APPLIED', summary: `已记录：${title}`, decisionRequestIds: [] },
      })
    }
    return reply(route, { code: 'UNEXPECTED_ACTION' }, 400)
  })
  return { commandCount: () => commandCount }
}
