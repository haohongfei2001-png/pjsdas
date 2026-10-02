#!/usr/bin/env node
// Synthetic, no-network regressions against actual repository source.
// From the repository directory:
// node --import tsx tests/fixtures/discoveryBudgetBoundary.mjs "$PWD"
// No model/provider requests, live credentials, writes, or production data.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(process.argv[2] || process.cwd())
const source = relative => import(pathToFileURL(path.join(repo, relative)).href)
const { runDiscoveryAutomationForBinding } = await source('gateway/discoveryAutomationWorker.ts')
const { createDefaultDiscoveryProfile } = await source('src/discoveryProfile.ts')
const { createDiscoveryReadinessReader } = await source('gateway/discoveryReadinessReader.ts')
const { createAutomationSettingsHandler } = await source('gateway/automationSettingsHandler.ts')
const owner = '00000000-0000-4000-8000-000000000001'
const before = {
  authority: process.env.PJSDAS_CONNECTED_AUTHORITY,
  service: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY,
}

try {
  process.env.PJSDAS_CONNECTED_AUTHORITY = 'transactional'
  process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service'
  const snapshot = JSON.parse(await readFile(path.join(repo, 'gateway/fixtures/demo-workspace.json'), 'utf8'))
  snapshot.data.discoveryProfile = {
    ...createDefaultDiscoveryProfile(), targetRoleQueries: ['Synthetic role'],
  }
  let generated = 0
  for (const force of [false, true]) {
    await assert.rejects(() => runDiscoveryAutomationForBinding({
      binding: { userId: owner, refreshTokenCiphertext: 'synthetic-unused' },
      tokenEncryptionKey: 'synthetic-unused',
      googleClientId: 'synthetic-unused',
      googleClientSecret: 'synthetic-unused',
      force,
      // This records an attempted model call but never contacts a provider.
      generateTextImpl: async () => {
        generated++
        throw new Error('Model must never run without a reservation adapter')
      },
      fetchImpl: async (input, init) => {
        assert.equal(init?.method ?? 'GET', 'GET')
        const url = new URL(String(input))
        assert.ok(url.pathname.endsWith('/pjsdas_workspaces'))
        assert.equal(url.searchParams.get('user_id'), `eq.${owner}`)
        return Response.json([{
          id: owner, user_id: owner, revision: 1,
          schema_version: snapshot.version, snapshot,
        }])
      },
    }), error => error.code === 'DISCOVERY_BUDGET_APPROVAL_REQUIRED')
  }
  assert.equal(generated, 0)
  console.log('PASS configured normal and forced workers deny without an adapter; zero generator calls.')

  const timedRead = createDiscoveryReadinessReader({
    transactional: true,
    supabaseUrl: 'https://fixture.invalid',
    serviceRoleKey: 'synthetic-service',
    fetchImpl: async (input, init) => new Promise((resolve, reject) => {
      const query = new URL(String(input)).searchParams
      assert.equal(query.get('select'), 'user_id,profile:snapshot->data->discoveryProfile')
      assert.equal(query.get('user_id'), `eq.${owner}`)
      assert.ok(init.signal)
      // Cooperate with the production reader's AbortSignal, like native fetch.
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }),
  })
  const started = performance.now()
  let deadline
  try {
    const result = await Promise.race([
      timedRead(owner),
      new Promise((resolve, reject) => {
        // Keeps Node alive while AbortSignal.timeout's unref'ed timer runs.
        deadline = setTimeout(() => reject(new Error('Readiness read did not abort')), 5000)
      }),
    ])
    assert.deepEqual(result, { profileConfigured: null, budgetState: 'approval_required' })
    console.log(`PASS stalled profile projection aborts to unknown after ${Math.round(performance.now() - started)} ms.`)
  } finally {
    clearTimeout(deadline)
  }

  const handler = createAutomationSettingsHandler({
    supabaseUrl: 'https://fixture.invalid',
    supabasePublishableKey: 'synthetic-public',
    allowedOrigins: ['https://app.invalid'],
    readDiscoveryReadiness: async userId => {
      assert.equal(userId, owner)
      throw new Error('Synthetic projection outage')
    },
    fetchImpl: async input => {
      const url = new URL(String(input))
      if (url.pathname === '/auth/v1/user') return Response.json({ id: owner })
      assert.equal(url.pathname, '/rest/v1/google_drive_connections')
      assert.equal(url.searchParams.get('user_id'), `eq.${owner}`)
      return Response.json([{
        user_id: owner, google_email: 'synthetic@example.invalid',
        gmail_automation_enabled: true, discovery_automation_enabled: true,
      }])
    },
  })
  const response = await handler(new Request('https://fixture.invalid/api/automation-settings', {
    method: 'POST',
    headers: {
      origin: 'https://app.invalid', authorization: 'Bearer synthetic',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'read', userId: 'foreign-account' }),
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.gmailEnabled, true)
  assert.deepEqual(body.discoveryReadiness, { profileConfigured: null, budgetState: 'approval_required' })
  assert.equal(JSON.stringify(body).includes('Synthetic projection outage'), false)
  console.log('PASS projection failure preserves Gmail status and a caller-supplied account cannot select the profile.')
} finally {
  for (const [key, value] of [
    ['PJSDAS_CONNECTED_AUTHORITY', before.authority],
    ['PJSDAS_SUPABASE_SERVICE_ROLE_KEY', before.service],
  ]) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
