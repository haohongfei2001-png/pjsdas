/** Exact-production CGR-03 journeys, isolated to one short-lived synthetic account. */
import { randomBytes, randomUUID } from 'node:crypto'
import { chromium, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { PJSDAS_SUPABASE_URL, PJSDAS_SUPABASE_PUBLISHABLE_KEY } from '../gateway/supabaseProject.js'
import { createJobPostingEvidence } from '../src/jobPosting.js'
import { upgradeSnapshotToLatest, validateSnapshot } from '../src/snapshot.js'

const purpose = 'pjsdas-cgr03-synthetic-canary'
const projectRef = new URL(PJSDAS_SUPABASE_URL).hostname.split('.')[0]
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing ${name}; no test identity created.`); return value }
async function json(url: string, options?: RequestInit) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) })
  const value = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || !value) throw new Error(`Production HTTP ${response.status}; response withheld.`)
  return value
}
async function preflight() {
  const url = new URL(required('PJSDAS_CGR03_CANARY_ORIGIN'))
  const sha = required('PJSDAS_EXPECTED_COMMIT_SHA').toLowerCase()
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid origin/SHA; no test identity created.')
  const [health, manifest] = await Promise.all([json(`${url.origin}/api/health`), json(`${url.origin}/release-manifest.json`)])
  if ((health.release as { commitSha?: string } | undefined)?.commitSha !== sha || health.workspaceAuthority !== 'transactional' || manifest.commitSha !== sha) throw new Error('Production API/frontend SHA mismatch; no test identity created.')
  return { origin: url.origin, sha }
}
function fixture() {
  const tag = randomUUID().slice(0, 8), now = new Date().toISOString(), company = '歧义科技'
  const opportunity = (role: string, suffix: string) => {
    const id = `cgr03-${tag}-${suffix}`, sourceUrl = `https://example.invalid/cgr03/${id}`
    return { id, company, role, currentStageLabel: '待投递', processStage: 'not_applied' as const,
      roleType: 'core' as const, early: false, opportunityValue: 86, fitScore: 80, locallyManaged: true, importedAt: now,
      detail: { discovery: { sourceUrl, sourceTitle: role, rationale: 'synthetic canary', discoveredAt: now,
        fitConfidence: 'high' as const, opportunityValueConfidence: 'high' as const,
        posting: createJobPostingEvidence({ company, role, sourceUrl, sourceTitle: role, observedAt: now }) } } }
  }
  const growth = opportunity('产品经理-增长', 'growth'), commercial = opportunity('产品经理-商业化', 'commercial')
  const action = { id: `cgr03-action-${tag}`, kind: 'manual' as const, title: `核对 ${company} 增长岗位`,
    opportunityId: growth.id, processStage: 'not_applied' as const, estimatedMinutes: 20, leverage: 85, delayCost: 80,
    status: 'todo' as const, createdAt: now, updatedAt: now }
  const snapshot = upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1, exportedAt: now,
    data: { opportunities: [growth, commercial], processes: [], processEvents: [], actions: [action], prep: [], applicationGroups: [], semanticReceipts: [], timeline: [] } })
  validateSnapshot(snapshot)
  return { company, growth, action, snapshot }
}
async function workspace(origin: string, token: string, body: Record<string, unknown>) {
  return json(`${origin}/api/workspace`, { method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
async function run() {
  const data = fixture()
  if (process.argv.includes('--plan')) { console.log('CGR-03 synthetic fixture valid; plan has no network or write.'); return }
  if (!process.argv.includes('--execute')) throw new Error('Use --plan or --execute.')
  const { origin, sha } = await preflight()
  const admin = createClient(PJSDAS_SUPABASE_URL, required('PJSDAS_SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } })
  const email = `cgr03-canary-${randomUUID()}@example.invalid`, password = randomBytes(48).toString('base64url')
  let userId: string | undefined, granted = false, passed = false, failure: unknown
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let clientA: ReturnType<typeof createClient> | undefined
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { purpose } })
    if (created.error || !created.data.user?.id || created.data.user.email !== email) throw new Error('Synthetic identity creation failed.')
    userId = created.data.user.id
    const grant = await admin.from('pjsdas_access_grants').insert({ user_id: userId, email, role: 'beta', note: 'CGR-03 temporary synthetic browser canary' })
    if (grant.error) throw new Error('Synthetic audience grant failed.')
    granted = true
    const opts = { auth: { persistSession: false, autoRefreshToken: false } }
    clientA = createClient(PJSDAS_SUPABASE_URL, PJSDAS_SUPABASE_PUBLISHABLE_KEY, opts)
    const clientB = createClient(PJSDAS_SUPABASE_URL, PJSDAS_SUPABASE_PUBLISHABLE_KEY, opts)
    const [a,b] = await Promise.all([clientA.auth.signInWithPassword({ email, password }), clientB.auth.signInWithPassword({ email, password })])
    const tokenA = a.data.session?.access_token, tokenB = b.data.session?.access_token
    if (a.error || b.error || !tokenA || !tokenB || tokenA === tokenB || a.data.user?.id !== userId || b.data.user?.id !== userId) throw new Error('Distinct synthetic sessions failed.')
    const seeded = await workspace(origin, tokenA, { action: 'bootstrap', confirmMigration: true, snapshot: data.snapshot, migratedFrom: 'cgr03-synthetic-fixture' })
    if (seeded.outcome !== 'MIGRATED_OR_ALREADY_MATCHED' || seeded.revision !== 0) throw new Error('Synthetic workspace bootstrap failed.')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: `sb-${projectRef}-auth-token`, value: JSON.stringify(a.data.session) })
    const page = await context.newPage()
    await page.goto(`${origin}/opportunities`, { waitUntil: 'domcontentloaded' })
    await page.locator('.opportunity-decision-filter select').selectOption('all')
    await expect(page.locator('.opportunity-decision-row').filter({ hasText: data.company })).toHaveCount(2, { timeout: 20000 })
    await page.goto(`${origin}/opportunities/${encodeURIComponent(data.growth.id)}`, { waitUntil: 'domcontentloaded' })
    const detail = page.getByRole('dialog', { name: /岗位详情|Opportunity details/ })
    await expect(detail).toContainText('产品经理-增长', { timeout: 20000 })
    await page.reload()
    await expect(detail).toContainText('产品经理-增长', { timeout: 20000 })
    await detail.locator('.opportunity-detail-section').filter({ hasText: /准备与相关待办|Preparation & related actions/ }).locator('summary').click()
    await detail.getByRole('button', { name: /标记完成|Mark done/ }).click()
    await expect(page.locator('.action-undo-toast')).toContainText(/已标记完成|Marked done/)
    const done = await workspace(origin, tokenB, { action: 'read' })
    if ((done.snapshot as typeof data.snapshot).data.actions.find(item => item.id === data.action.id)?.status !== 'done') throw new Error('Cross-session action mutation missing.')
    await page.locator('.action-undo-toast').getByRole('button', { name: /撤销|Undo/ }).click()
    await expect(page.locator('.action-undo-toast')).toHaveCount(0)
    const undone = await workspace(origin, tokenB, { action: 'read' })
    if ((undone.snapshot as typeof data.snapshot).data.actions.find(item => item.id === data.action.id)?.status !== 'todo') throw new Error('Cross-session Undo missing.')
    await page.keyboard.press('Escape')
    await page.locator('.ultimate-mobile-capture').click()
    await page.locator('.cgr-capture-input').fill(`投递 ${data.company}产品经理。`)
    await page.getByRole('button', { name: '确认并保存' }).click()
    await expect(page.getByRole('status')).toContainText('1 项需要你决定')
    await page.getByRole('button', { name: '去决定' }).click()
    await expect(page.getByRole('heading', { name: '只处理真正需要你决定的事' })).toBeVisible()
    await page.getByRole('button', { name: new RegExp(data.company + '.*产品经理-增长') }).click()
    await expect(page.locator('.ultimate-receipt')).toContainText('决定已处理')
    const decided = await workspace(origin, tokenB, { action: 'read' })
    if ((decided.snapshot as typeof data.snapshot).data.opportunities.find(item => item.id === data.growth.id)?.processStage !== 'screening') throw new Error('Cross-session decision mutation missing.')
    passed = true
    await context.close()
  } catch (error) { failure = error }
  finally {
    await browser?.close().catch(() => undefined)
    if (userId) {
      const errors: string[] = []
      let revoked = !granted
      if (granted) { const result = await admin.from('pjsdas_access_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId); if (result.error) errors.push('grant revocation'); else revoked = true }
      const signedOut = await clientA?.auth.signOut({ scope: 'global' }); if (signedOut?.error) errors.push('session revocation')
      if (passed || !granted) {
        const checked = await admin.auth.admin.getUserById(userId)
        if (checked.error || checked.data.user?.email !== email || checked.data.user?.app_metadata?.purpose !== purpose) errors.push('identity verification')
        else { const deleted = await admin.auth.admin.deleteUser(userId); if (deleted.error) errors.push('synthetic account deletion') }
      }
      if (!revoked || errors.length) throw new Error(`Synthetic cleanup incomplete (${errors.join(', ')}); user ${userId} needs controlled recovery.`)
      if (!passed && granted) console.log(`CGR-03 synthetic account access revoked; user ${userId} retained for receipt recovery.`)
      else console.log('CGR-03 synthetic account and access grant removed.')
    }
  }
  if (failure) throw failure
  console.log(JSON.stringify({ result: 'PASS', exactSha: sha, journeys: ['list','detail','deep-link','decision','action','undo'], crossSession: true, content: 'synthetic-only' }))
}
run().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'CGR-03 canary failed.'); process.exitCode = 1 })
