import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { PJSDAS_SUPABASE_PUBLISHABLE_KEY, PJSDAS_SUPABASE_URL } from '../gateway/supabaseProject.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'

const purpose = 'pjsdas-reliability-hotfix-production-canary'
const protocolVersion = '2026-07-28'

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}; no synthetic identity was created.`)
  return value
}

async function httpJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
  if (!response.ok || !body) throw new Error(`Production HTTP ${response.status}; response withheld.`)
  return body
}

async function preflight() {
  const origin = new URL(required('PJSDAS_RH_CANARY_ORIGIN'))
  const expectedSha = required('PJSDAS_EXPECTED_COMMIT_SHA').toLowerCase()
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || !/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error('Invalid production origin or exact SHA; no synthetic identity was created.')
  }
  const deadline = Date.now() + 8 * 60_000
  while (true) {
    try {
      const [health, manifest] = await Promise.all([
        httpJson(`${origin.origin}/api/health`),
        httpJson(`${origin.origin}/release-manifest.json`),
      ])
      const release = health.release as { commitSha?: string } | undefined
      if (release?.commitSha === expectedSha && manifest.commitSha === expectedSha) {
        if (health.workspaceAuthority !== 'transactional') {
          throw new Error('Exact production SHA is not using transactional workspace authority.')
        }
        const mcp = health.authenticatedMcp as { releaseRequiredTools?: string[] } | undefined
        const requiredTools = mcp?.releaseRequiredTools ?? []
        for (const tool of ['add_opportunities', 'ingest_discovery_run', 'ingest_gmail_run']) {
          if (!requiredTools.includes(tool)) throw new Error(`Production health is missing required tool ${tool}.`)
        }
        return { origin: origin.origin, expectedSha }
      }
    } catch (error) {
      if (Date.now() >= deadline) throw error
    }
    if (Date.now() >= deadline) {
      throw new Error('Production did not serve the exact hotfix SHA before the preflight deadline; no synthetic identity was created.')
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000))
  }
}

function requestMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': { name: 'pjsdas-rh-production-canary', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  }
}

function parseEnvelope(raw: string) {
  const candidates = raw.includes('data:')
    ? raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
    : [raw]
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index]!) as { error?: { message?: string }; result?: Record<string, unknown> }
      if (parsed.error) throw new Error(parsed.error.message ?? 'MCP protocol error.')
      if (parsed.result) return parsed.result
    } catch (error) {
      if (index === 0) throw error
    }
  }
  throw new Error('MCP response did not contain a result.')
}

async function mcp(origin: string, token: string, method: 'tools/list' | 'tools/call', params: Record<string, unknown>, toolName?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion,
    'Mcp-Method': method,
  }
  if (toolName) headers['Mcp-Name'] = toolName
  const response = await fetch(`${origin}/api/mcp`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${method}-${randomUUID()}`,
      method,
      params: { ...params, _meta: requestMeta() },
    }),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`Production MCP HTTP ${response.status}; response withheld.`)
  return parseEnvelope(raw)
}

function toolPayload(result: Record<string, unknown>) {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as Record<string, unknown>
  }
  const content = result.content
  if (!Array.isArray(content)) return {}
  const text = content.find((item) => item && typeof item === 'object' && (item as { type?: string }).type === 'text') as { text?: string } | undefined
  if (!text?.text) return {}
  try { return JSON.parse(text.text) as Record<string, unknown> } catch { return {} }
}

async function workspace(origin: string, token: string, body: Record<string, unknown>) {
  return httpJson(`${origin}/api/workspace`, {
    method: 'POST',
    headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function emptySnapshot() {
  const snapshot = upgradeSnapshotToLatest({
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
      decisionRequests: [], semanticReceipts: [], reminderIntents: [], reminderOutbox: [], timeline: [],
    },
  })
  validateSnapshot(snapshot)
  return snapshot
}

async function callTool(origin: string, token: string, name: string, args: Record<string, unknown>) {
  return mcp(origin, token, 'tools/call', { name, arguments: args }, name)
}

function sourceCandidate(company: string, sourceUrl: string) {
  return {
    company,
    role: '产品经理培训生（RPT）',
    sourceUrl,
    sourceTitle: `${company} 产品经理培训生（RPT）`,
    location: '北京',
    rationale: 'Synthetic reliability canary for posting identity only.',
    roleType: 'core',
    postingStatus: 'open',
  }
}

async function execute() {
  if (process.argv.includes('--plan')) {
    console.log('RH production canary plan valid: exact SHA -> synthetic owner account -> stable MCP tools/list -> no-grant AUTH_FORBIDDEN -> two distinct posting URLs -> tracking duplicate -> readback -> cleanup. No network/write occurred.')
    return
  }
  if (!process.argv.includes('--execute')) throw new Error('Use --plan or --execute.')

  const { origin, expectedSha } = await preflight()
  const serviceRoleKey = required('PJSDAS_SUPABASE_SERVICE_ROLE_KEY')
  const admin = createClient(PJSDAS_SUPABASE_URL, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const email = `rh-canary-${randomUUID()}@example.invalid`
  const password = randomBytes(48).toString('base64url')
  const company = `Synthetic RH ${randomUUID().slice(0, 8)}`
  let userId: string | undefined
  let client: ReturnType<typeof createClient> | undefined
  let granted = false
  let failure: unknown

  try {
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { purpose },
    })
    if (created.error || !created.data.user?.id || created.data.user.email !== email) throw new Error('Synthetic user creation failed.')
    userId = created.data.user.id

    const access = await admin.from('pjsdas_access_grants').insert({
      user_id: userId,
      email,
      role: 'beta',
      note: 'Reliability hotfix production canary; temporary synthetic identity',
    })
    if (access.error) throw new Error('Synthetic audience grant creation failed.')
    granted = true

    client = createClient(PJSDAS_SUPABASE_URL, PJSDAS_SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const signedIn = await client.auth.signInWithPassword({ email, password })
    const token = signedIn.data.session?.access_token
    if (signedIn.error || !token || signedIn.data.user?.id !== userId) throw new Error('Synthetic sign-in failed.')

    const bootstrapped = await workspace(origin, token, {
      action: 'bootstrap',
      confirmMigration: true,
      snapshot: emptySnapshot(),
      migratedFrom: 'reliability-hotfix-synthetic-canary',
    })
    if (bootstrapped.outcome !== 'MIGRATED_OR_ALREADY_MATCHED' || bootstrapped.revision !== 0) {
      throw new Error('Synthetic workspace bootstrap failed.')
    }

    const listed = await mcp(origin, token, 'tools/list', {})
    const tools = Array.isArray(listed.tools) ? listed.tools as Array<{ name?: string }> : []
    const names = new Set(tools.map((item) => item.name).filter((name): name is string => Boolean(name)))
    for (const name of ['add_opportunities', 'ingest_discovery_run', 'ingest_gmail_run']) {
      if (!names.has(name)) throw new Error(`Authenticated tools/list omitted ${name}.`)
    }

    const beforeDenied = await workspace(origin, token, { action: 'read' })
    const denied = await callTool(origin, token, 'ingest_discovery_run', {
      runId: `rh-no-grant-${randomUUID()}`,
      sourceId: 'monitor:key-changes',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      dryRun: true,
      observations: [],
    })
    const deniedBody = toolPayload(denied)
    if (denied.isError !== true || deniedBody.code !== 'AUTH_FORBIDDEN') {
      throw new Error('No-grant advertised ingestion tool did not fail inside the handler with AUTH_FORBIDDEN.')
    }
    const afterDenied = await workspace(origin, token, { action: 'read' })
    if (afterDenied.revision !== beforeDenied.revision) throw new Error('Denied trusted-ingestion call changed workspace revision.')

    const firstUrl = 'https://careers.example.invalid/position/1001'
    const secondUrl = 'https://careers.example.invalid/position/1002'
    const first = toolPayload(await callTool(origin, token, 'add_opportunities', {
      opportunities: [sourceCandidate(company, firstUrl)],
    }))
    if (first.createdCount !== 1 || first.duplicateCount !== 0 || first.reviewRequired !== false) {
      throw new Error('First exact posting was not created cleanly.')
    }

    const second = toolPayload(await callTool(origin, token, 'add_opportunities', {
      opportunities: [sourceCandidate(company, secondUrl)],
    }))
    if (second.createdCount !== 1 || second.duplicateCount !== 0 || second.reviewRequired !== false) {
      throw new Error('Distinct exact posting was incorrectly merged or sent to review.')
    }

    const replay = toolPayload(await callTool(origin, token, 'add_opportunities', {
      opportunities: [sourceCandidate(company, `${secondUrl}?utm_source=rh&ref=canary`)],
    }))
    if (replay.createdCount !== 0 || replay.duplicateCount !== 1 || replay.reviewRequired !== false) {
      throw new Error('Tracking variant of the same exact posting was not deduplicated.')
    }

    const finalBody = await workspace(origin, token, { action: 'read' })
    const finalSnapshot = finalBody.snapshot as PJSDASSnapshot | undefined
    if (!finalSnapshot) throw new Error('Synthetic workspace read omitted snapshot.')
    validateSnapshot(finalSnapshot)
    const matches = finalSnapshot.data.opportunities.filter((item) => item.company === company)
    if (matches.length !== 2) throw new Error('Production posting-identity canary did not retain exactly two distinct Opportunities.')
    const urls = matches.map((item) => item.detail?.discovery?.posting?.canonicalSourceUrl).sort()
    if (JSON.stringify(urls) !== JSON.stringify([firstUrl, secondUrl].sort())) {
      throw new Error('Production posting identities do not match the two exact canonical URLs.')
    }

  } catch (error) {
    failure = error
  } finally {
    if (userId) {
      const cleanupErrors: string[] = []
      if (granted) {
        const revoked = await admin.from('pjsdas_access_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId)
        if (revoked.error) cleanupErrors.push('audience grant revocation')
      }
      if (client) {
        const signedOut = await client.auth.signOut({ scope: 'global' })
        if (signedOut.error) cleanupErrors.push('session revocation')
      }
      const deleted = await admin.auth.admin.deleteUser(userId)
      if (deleted.error) cleanupErrors.push('synthetic user deletion')
      if (!deleted.error) {
        const [identity, grantRows, workspaceRows, ledgerRows] = await Promise.all([
          admin.auth.admin.getUserById(userId),
          admin.from('pjsdas_access_grants').select('user_id', { count: 'exact', head: true }).eq('user_id', userId),
          admin.from('pjsdas_workspaces').select('id', { count: 'exact', head: true }).eq('user_id', userId),
          admin.from('pjsdas_command_ledger').select('id', { count: 'exact', head: true }).eq('user_id', userId),
        ])
        if (identity.data.user || !identity.error) cleanupErrors.push('auth identity cleanup verification')
        if (grantRows.error || grantRows.count !== 0) cleanupErrors.push('audience grant cleanup verification')
        if (workspaceRows.error || workspaceRows.count !== 0) cleanupErrors.push('workspace cleanup verification')
        if (ledgerRows.error || ledgerRows.count !== 0) cleanupErrors.push('ledger cleanup verification')
      }
      if (cleanupErrors.length) {
        throw new Error(`Synthetic canary cleanup incomplete (${cleanupErrors.join(', ')}); user ${userId} requires controlled recovery.`)
      }
      console.log('RH synthetic identity, audience grant, workspace and ledger cleanup verified.')
    }
  }

  if (failure) throw failure
  console.log(JSON.stringify({
    result: 'PASS',
    exactSha: expectedSha,
    journeys: [
      'stable-authenticated-tools-list',
      'advertised-no-grant-auth-forbidden',
      'denied-call-no-write',
      'distinct-posting-identity',
      'tracking-variant-idempotency',
      'synthetic-cleanup-zero-residual',
    ],
    content: 'synthetic-only',
    delegatedHostOAuthCertified: false,
    serverDiscoveryEnabledForOwnerCertified: false,
  }))
}

execute().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Reliability hotfix production canary failed.')
  process.exitCode = 1
})
