/** Production MCP-boundary canary for CGR-04, isolated to one synthetic account.
 *
 * This certifies the real production /api/mcp transport and source-neutral Semantic Intake
 * contract without touching the owner's workspace or any real recruiting system.
 *
 * It deliberately does NOT claim a real ChatGPT delegated-OAuth host session or an authorized
 * PAIA connection. The PAIA leg verifies fail-closed behavior when no delegated grant exists.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { PJSDAS_SUPABASE_PUBLISHABLE_KEY, PJSDAS_SUPABASE_URL } from '../gateway/supabaseProject.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'

const purpose = 'pjsdas-cgr04-current-chat-synthetic-canary'
const protocolVersion = '2026-07-28'
const projectRef = new URL(PJSDAS_SUPABASE_URL).hostname.split('.')[0]

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}; no test identity created.`)
  return value
}

async function json(url: string, options?: RequestInit) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  const value = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
  if (!response.ok || !value) throw new Error(`Production HTTP ${response.status}; response withheld.`)
  return value
}

async function preflight() {
  const url = new URL(required('PJSDAS_CGR04_CANARY_ORIGIN'))
  const sha = required('PJSDAS_EXPECTED_COMMIT_SHA').toLowerCase()
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('Invalid production origin/SHA; no test identity created.')
  }
  const [health, manifest] = await Promise.all([
    json(`${url.origin}/api/health`),
    json(`${url.origin}/release-manifest.json`),
  ])
  const release = health.release as { commitSha?: string } | undefined
  const mcp = health.authenticatedMcp as { releaseRequiredTools?: string[] } | undefined
  const tools = mcp?.releaseRequiredTools ?? []
  if (
    release?.commitSha !== sha
    || manifest.commitSha !== sha
    || health.workspaceAuthority !== 'transactional'
    || !tools.includes('semantic_intake')
    || !tools.includes('resolve_semantic_decision')
    || !tools.includes('ingest_paia_input')
  ) {
    throw new Error('Production exact-SHA or authenticated MCP surface mismatch; no test identity created.')
  }
  return { origin: url.origin, sha }
}

function fixture() {
  const tag = randomUUID().slice(0, 8)
  const now = new Date().toISOString()
  const company = `Synthetic Current Chat ${tag}`
  const opportunity = (id: string, role: string) => ({
    id,
    company,
    role,
    currentStageLabel: '筛选中',
    processStage: 'screening' as const,
    roleType: 'core' as const,
    participationStatus: 'active' as const,
    early: false,
    opportunityValue: 80,
    fitScore: 80,
    locallyManaged: true,
    importedAt: now,
  })
  const first = opportunity(`cgr04-${tag}-a`, '产品经理-A')
  const second = opportunity(`cgr04-${tag}-b`, '产品经理-B')
  const snapshot = upgradeSnapshotToLatest({
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: now,
    data: {
      opportunities: [first, second],
      processes: [],
      processEvents: [],
      actions: [],
      prep: [],
      applicationGroups: [],
      semanticReceipts: [],
      timeline: [],
    },
  })
  validateSnapshot(snapshot)
  return { tag, company, first, second, snapshot }
}

async function workspace(origin: string, token: string, body: Record<string, unknown>) {
  return json(`${origin}/api/workspace`, {
    method: 'POST',
    headers: {
      origin,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function requestMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': {
      name: 'pjsdas-cgr04-production-canary',
      version: '1.0.0',
    },
    'io.modelcontextprotocol/clientCapabilities': {},
  }
}

function parseMcpPayload(raw: string) {
  const candidates = raw.includes('data:')
    ? raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
    : [raw]
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index]!) as {
        error?: { message?: string }
        result?: {
          isError?: boolean
          content?: Array<{ type?: string; text?: string }>
          structuredContent?: Record<string, unknown>
        }
      }
      if (parsed.error) throw new Error(parsed.error.message ?? 'MCP protocol error.')
      if (parsed.result) return parsed.result
    } catch (error) {
      if (index === 0) throw error
    }
  }
  throw new Error('MCP response did not contain a tool result.')
}

async function mcpTool(origin: string, token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${origin}/api/mcp`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': protocolVersion,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-${randomUUID()}`,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: requestMeta(),
      },
    }),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`Production MCP HTTP ${response.status}; response withheld.`)
  return parseMcpPayload(raw)
}

function toolStructured(result: Awaited<ReturnType<typeof mcpTool>>) {
  if (result.structuredContent) return result.structuredContent
  const text = result.content?.find((item) => item.type === 'text')?.text
  if (!text) return {}
  try { return JSON.parse(text) as Record<string, unknown> } catch { return {} }
}

function snapshotFromWorkspace(body: Record<string, unknown>) {
  const snapshot = body.snapshot as PJSDASSnapshot | undefined
  if (!snapshot) throw new Error('Production workspace read omitted snapshot.')
  validateSnapshot(snapshot)
  return snapshot
}

async function run() {
  const data = fixture()
  if (process.argv.includes('--plan')) {
    console.log('CGR-04 current-chat synthetic fixture valid; plan has no network or write.')
    return
  }
  if (!process.argv.includes('--execute')) throw new Error('Use --plan or --execute.')

  const { origin, sha } = await preflight()
  const admin = createClient(PJSDAS_SUPABASE_URL, required('PJSDAS_SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const email = `cgr04-current-chat-${randomUUID()}@example.invalid`
  const password = randomBytes(48).toString('base64url')
  let userId: string | undefined
  let granted = false
  let clientA: ReturnType<typeof createClient> | undefined
  let failure: unknown
  let passed = false

  try {
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { purpose },
    })
    if (created.error || !created.data.user?.id || created.data.user.email !== email) {
      throw new Error('Synthetic identity creation failed.')
    }
    userId = created.data.user.id
    const grant = await admin.from('pjsdas_access_grants').insert({
      user_id: userId,
      email,
      role: 'beta',
      note: 'CGR-04 temporary current-chat production canary',
    })
    if (grant.error) throw new Error('Synthetic audience grant failed.')
    granted = true

    const options = { auth: { persistSession: false, autoRefreshToken: false } }
    clientA = createClient(PJSDAS_SUPABASE_URL, PJSDAS_SUPABASE_PUBLISHABLE_KEY, options)
    const clientB = createClient(PJSDAS_SUPABASE_URL, PJSDAS_SUPABASE_PUBLISHABLE_KEY, options)
    const [a, b] = await Promise.all([
      clientA.auth.signInWithPassword({ email, password }),
      clientB.auth.signInWithPassword({ email, password }),
    ])
    const tokenA = a.data.session?.access_token
    const tokenB = b.data.session?.access_token
    if (a.error || b.error || !tokenA || !tokenB || tokenA === tokenB || a.data.user?.id !== userId || b.data.user?.id !== userId) {
      throw new Error('Distinct synthetic sessions failed.')
    }

    const seeded = await workspace(origin, tokenA, {
      action: 'bootstrap',
      confirmMigration: true,
      snapshot: data.snapshot,
      migratedFrom: 'cgr04-current-chat-synthetic-fixture',
    })
    if (seeded.outcome !== 'MIGRATED_OR_ALREADY_MATCHED' || seeded.revision !== 0) {
      throw new Error('Synthetic workspace bootstrap failed.')
    }

    const inputId = `cgr04-current-chat-${data.tag}`
    const source = {
      kind: 'mcp',
      sourceId: `chatgpt-current:${data.tag}`,
      sourceRecordId: `message:${data.tag}`,
      sourceVersion: 'v1',
      observedAt: new Date().toISOString(),
      assertedAt: new Date().toISOString(),
      timezone: 'Asia/Shanghai',
    }
    const observation = {
      contractVersion: 1,
      inputId,
      source,
      statementMode: 'assertion',
      originalTextFingerprint: `synthetic:${data.tag}`,
      candidates: [{
        id: 'candidate-ambiguous',
        kind: 'abandon_opportunity',
        target: { company: data.company },
        objectConfidence: 'high',
        eventConfidence: 'high',
        evidenceRefs: [`synthetic:${data.tag}`],
        sourceVersionRefs: ['v1'],
      }],
    }

    const firstCall = await mcpTool(origin, tokenA, 'semantic_intake', observation)
    if (firstCall.isError) throw new Error('Current-chat Semantic Intake unexpectedly failed.')
    const firstResult = toolStructured(firstCall)
    if (firstResult.decisionRequired !== true) throw new Error('Current-chat ambiguity did not produce DecisionRequest.')

    const afterFirstBody = await workspace(origin, tokenB, { action: 'read' })
    const afterFirst = snapshotFromWorkspace(afterFirstBody)
    const decisions = afterFirst.data.decisionRequests ?? []
    if (decisions.length !== 1 || decisions[0]?.reason !== 'ambiguous_target' || decisions[0]?.choices.length !== 2) {
      throw new Error('Cross-session DecisionRequest projection is incorrect.')
    }
    if (afterFirst.data.opportunities.some((item) => item.participationStatus === 'abandoned')) {
      throw new Error('Ambiguous current-chat input guessed a business write.')
    }

    const revisionAfterFirst = afterFirstBody.revision
    const replay = await mcpTool(origin, tokenA, 'semantic_intake', observation)
    if (replay.isError) throw new Error('Current-chat replay unexpectedly failed.')
    const afterReplayBody = await workspace(origin, tokenB, { action: 'read' })
    const afterReplay = snapshotFromWorkspace(afterReplayBody)
    if ((afterReplay.data.decisionRequests ?? []).length !== 1 || afterReplayBody.revision !== revisionAfterFirst) {
      throw new Error('Current-chat replay duplicated state or advanced authoritative revision.')
    }

    const decision = (afterReplay.data.decisionRequests ?? [])[0]!
    const choice = decision.choices.find((item) => item.resolution?.opportunityId === data.first.id)
    if (!choice) throw new Error('Expected bounded DecisionRequest choice is missing.')
    const resolved = await mcpTool(origin, tokenA, 'resolve_semantic_decision', {
      requestId: decision.id,
      choiceId: choice.id,
    })
    if (resolved.isError) throw new Error('Current-chat DecisionRequest resolution failed.')

    const afterResolve = snapshotFromWorkspace(await workspace(origin, tokenB, { action: 'read' }))
    const first = afterResolve.data.opportunities.find((item) => item.id === data.first.id)
    const second = afterResolve.data.opportunities.find((item) => item.id === data.second.id)
    const storedDecision = (afterResolve.data.decisionRequests ?? []).find((item) => item.id === decision.id)
    if (first?.participationStatus !== 'abandoned' || second?.participationStatus === 'abandoned' || storedDecision?.state !== 'answered') {
      throw new Error('Cross-session current-chat decision resolution did not persist exactly one bounded update.')
    }

    const beforePaia = await workspace(origin, tokenB, { action: 'read' })
    const paia = await mcpTool(origin, tokenA, 'ingest_paia_input', {
      ...observation,
      inputId: `cgr04-paia-denied-${data.tag}`,
      source: {
        ...source,
        kind: 'paia',
        sourceId: `paia:synthetic:${data.tag}`,
        sourceRecordId: `paia-input:${data.tag}`,
      },
    })
    const paiaBody = toolStructured(paia)
    if (!paia.isError || paiaBody.code !== 'AUTH_FORBIDDEN') {
      throw new Error('Unauthorized PAIA source did not fail closed with AUTH_FORBIDDEN.')
    }
    const afterPaia = await workspace(origin, tokenB, { action: 'read' })
    if (afterPaia.revision !== beforePaia.revision) {
      throw new Error('Unauthorized PAIA attempt changed authoritative workspace revision.')
    }

    passed = true
    console.log(JSON.stringify({
      result: 'PASS',
      exactSha: sha,
      journeys: [
        'production-mcp-transport',
        'current-chat-semantic-intake',
        'decision-request',
        'cross-session-readback',
        'replay-idempotency',
        'decision-resolution',
        'paia-no-grant-fail-closed',
      ],
      content: 'synthetic-only',
      delegatedHostOAuthCertified: false,
      authorizedPaiaTransportCertified: false,
    }))
  } catch (error) {
    failure = error
  } finally {
    if (userId) {
      const cleanupErrors: string[] = []
      if (granted) {
        const revoked = await admin.from('pjsdas_access_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId)
        if (revoked.error) cleanupErrors.push('audience grant revocation')
      }
      const signedOut = await clientA?.auth.signOut({ scope: 'global' })
      if (signedOut?.error) cleanupErrors.push('session revocation')
      if (passed) {
        const deleted = await admin.auth.admin.deleteUser(userId)
        if (deleted.error) cleanupErrors.push('synthetic account deletion')
      }
      if (cleanupErrors.length) {
        throw new Error(`Synthetic cleanup incomplete (${cleanupErrors.join(', ')}); user ${userId} needs controlled recovery.`)
      }
      if (!passed) console.log(`CGR-04 synthetic account access revoked; user ${userId} retained for receipt recovery.`)
      else console.log('CGR-04 synthetic account and access grant removed.')
    }
  }

  if (failure) throw failure
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'CGR-04 production MCP canary failed.')
  process.exitCode = 1
})
