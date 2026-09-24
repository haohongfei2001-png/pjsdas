import { expect, test, type Page, type Route } from '@playwright/test'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { createProgressChangeSet } from '../src/changeSet.js'
import { createMcpProposalEnvelope } from '../src/ai/mcpProposal.js'
import { applyMcpProgressCommand } from '../src/mcpProgressCommand.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'

const BACKEND = 'https://pjsdas-remote-alpha.vercel.app'
const AUTH_KEY = 'sb-yyrzwpoxlxpafdlbkdtg-auth-token'
const at = '2026-09-24T06:00:00.000Z'

function session() {
  return { access_token: 'synthetic-token', token_type: 'bearer', expires_in: 31_536_000,
    expires_at: Math.floor(Date.now() / 1000) + 31_536_000, refresh_token: 'refresh-synthetic-token',
    user: { id: 'account-a', aud: 'authenticated', role: 'authenticated', email: 'account-a@example.test',
      email_confirmed_at: at, phone: '', confirmed_at: at, last_sign_in_at: at,
      app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: { sub: 'account-a', full_name: 'Account A' }, identities: [],
      created_at: at, updated_at: at, is_anonymous: false } }
}

async function seedSession(page: Page) {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value))
  }, { key: AUTH_KEY, value: session() })
}

function cors(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, headers: {
    'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS', 'content-type': 'application/json',
  }, body: JSON.stringify(body) })
}

test('signed progress review commits one scoped account command and appears on another client', async ({ page, browser }) => {
  const initial = createSnapshot({
    opportunities: [{ id: 'opp-1', company: 'Synthetic', role: 'Designer', currentStageLabel: '待投',
      processStage: 'not_applied', roleType: 'core', early: false, opportunityValue: 70, fitScore: 75,
      locallyManaged: true, importedAt: at }],
    processes: [], processEvents: [], actions: [{ id: 'existing-action', kind: 'manual', title: 'Existing task',
      opportunityId: 'opp-1', estimatedMinutes: 15, leverage: 75, delayCost: 75, status: 'todo',
      createdAt: at, updatedAt: at }], prep: [], applicationGroups: [], timeline: [], changeSets: [],
  }, at)
  const changeSet = { ...createProgressChangeSet([{ id: 'new-task', kind: 'manual_action' as const,
    title: 'Review synthetic portfolio', estimatedMinutes: 20, occurredAt: at,
    sourceText: 'Reviewed synthetic proposal', confidence: 'high' as const }], new Date(at)),
    source: 'mcp' as const, expectedWorkspaceVersion: 'txn:7',
    expectedWorkspaceFingerprint: await fingerprintWorkspace(initial) }
  const proposal = createMcpProposalEnvelope(changeSet, 'txn:7', new Date(at), undefined, 'account-a')
  let state: PJSDASSnapshot = initial
  let revision = 7
  let commands = 0
  let snapshots = 0
  const routeBackend = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (url.pathname === '/api/health') return cors(route, { status: 'ok', version: '1.10.0-alpha.1',
      mode: 'transactional-connected', workspaceAuthority: 'transactional',
      capabilities: { deploymentPortability: true } })
    if (url.pathname === '/api/proposal-verify') return cors(route, { proposal })
    if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
    const body = request.postDataJSON() as any
    if (body.action === 'read') return cors(route, { workspaceId: 'ws-a', workspaceVersion: `txn:${revision}`,
      revision, schemaVersion: state.version, snapshot: state })
    if (body.action === 'command') {
      commands += 1
      expect(body.command).toMatchObject({ type: 'mcp_apply_progress', value: { token: 'synthetic-signed-token' } })
      expect(body).not.toHaveProperty('snapshot')
      state = applyMcpProgressCommand(state, proposal, new Date('2026-09-24T06:01:00.000Z')).snapshot
      revision += 1
      return cors(route, { outcome: 'COMMITTED', revision, workspaceVersion: `txn:${revision}`,
        schemaVersion: state.version, snapshot: state,
        receipt: { commandId: body.commandId, status: 'COMMITTED', revision,
          affectedObjects: [{ type: 'action', id: 'progress-action:new-task' }] } })
    }
    if (body.action === 'receipt') return cors(route, { found: false, revision,
      workspaceVersion: `txn:${revision}`, schemaVersion: state.version, snapshot: state })
    snapshots += 1
    return cors(route, { code: 'UNEXPECTED_ACTION', action: body.action }, 400)
  }

  await seedSession(page)
  await page.route(`${BACKEND}/**`, routeBackend)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Existing task' })).toBeVisible()
  await page.goto('/#pjsdas-proposal=synthetic-signed-token')
  await expect(page.getByRole('button', { name: '应用 ChangeSet' })).toBeVisible()
  await page.getByRole('button', { name: '应用 ChangeSet' }).click()
  await expect(page.locator('.mcp-proposal-result')).toContainText('账号工作区')
  expect(commands).toBe(1)
  expect(snapshots).toBe(0)

  const second = await browser.newContext()
  try {
    const otherPage = await second.newPage()
    await seedSession(otherPage)
    await otherPage.route(`${BACKEND}/**`, routeBackend)
    await otherPage.goto('/')
    await expect(otherPage.getByRole('button', { name: /Review synthetic portfolio/ })).toBeVisible()
  } finally { await second.close() }
})
