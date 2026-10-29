import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { guardMockApplicationRequests } from '../../e2e/support/mockApplicationRequests.js'
const ROOT = resolve(import.meta.dirname, '../..')
const URL = '/pjsdas/tests/stop-following-browser-private/index.html'
type SourceManifest = { contract: string; commit: string; tree: string; prHeadSha: string | null; parents: string[]; files: Array<{ path: string; mode: string; blob: string; sha256: string }> }
let source: SourceManifest
const guards = new WeakMap<BrowserContext, Awaited<ReturnType<typeof guardMockApplicationRequests>>>()
const harnessFiles = ['index.html', 'main.tsx', 'style.css', 'README.md', 'playwright.config.mts', 'stopFollowing.browser.ts', 'tsconfig.json'].map(x => 'tests/stop-following-browser-private/' + x)
function manifest(): SourceManifest {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}')
  expect(commit).toMatch(/^[a-f0-9]{40}$/); expect(tree).toMatch(/^[a-f0-9]{40}$/)
  // CI's merge-test checkout is not the PR head. Record both and bind the PR
  // head to a raw commit parent (works with Actions' shallow checkout too).
  const parents = git('cat-file', '-p', 'HEAD').split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7))
  const prHeadSha = process.env.TA_STOP_BROWSER_PR_HEAD || null
  if (prHeadSha) { expect(prHeadSha).toMatch(/^[a-f0-9]{40}$/); expect([commit, ...parents]).toContain(prHeadSha) }
  if (process.env.CI) {
    expect(process.env.TA_STOP_BROWSER_CHECKOUT).toBe(commit)
    expect(process.env.TA_STOP_BROWSER_TREE).toBe(tree)
    if (process.env.GITHUB_EVENT_NAME === 'pull_request') expect(prHeadSha).not.toBeNull()
  }
  if (process.env.TA_STOP_BROWSER_CHECKOUT) expect(process.env.TA_STOP_BROWSER_CHECKOUT).toBe(commit)
  if (process.env.TA_STOP_BROWSER_TREE) expect(process.env.TA_STOP_BROWSER_TREE).toBe(tree)
  const records = execFileSync('git', ['ls-tree', '-rz', '--full-tree', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
  const files = records.map(record => {
    const tab = record.indexOf('\t'), [mode, type, blob] = record.slice(0, tab).split(' '), path = record.slice(tab + 1)
    expect(type).toBe('blob'); expect(['100644', '100755']).toContain(mode)
    expect(path.split('/').every(part => part && part !== '.' && part !== '..')).toBe(true)
    let target = ROOT
    for (const part of path.split('/')) { target = resolve(target, part); expect(lstatSync(target).isSymbolicLink()).toBe(false) }
    expect(lstatSync(target).isFile()).toBe(true)
    expect(Boolean(lstatSync(target).mode & 0o111)).toBe(mode === '100755')
    const bytes = readFileSync(target)
    // Direct Git object hashing cannot be bypassed with assume-unchanged bits.
    expect(createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex')).toBe(blob)
    return { path, mode, blob, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  for (const path of harnessFiles) expect(files.some(file => file.path === path)).toBe(true)
  return { contract: 'stop-following-synthetic-browser-source-v1', commit, tree, prHeadSha, parents, files }
}
async function observe(page: Page): Promise<any> { return JSON.parse(await page.getByTestId('observations').innerText()) }
async function open(page: Page) { await page.getByRole('button', { name: 'Open actual job drawer', exact: true }).click(); await expect(page.getByRole('button', { name: '不再跟进', exact: true })).toBeVisible() }
async function fresh(page: Page, mode = 'Reset connected synthetic') {
  await page.goto(URL); await page.getByRole('button', { name: mode, exact: true }).click()
  await expect.poll(async () => (await observe(page)).serverRevision).toBe(0)
  await expect.poll(async () => (await observe(page)).localActionStates).toEqual(['todo', 'todo'])
}
async function close(page: Page) { await page.locator('.opportunity-detail-close').click(); await expect(page.locator('.opportunity-detail-drawer')).toHaveCount(0) }
test.beforeAll(() => { source = manifest() })
test.afterAll(() => { expect(manifest()).toEqual(source) })
test.beforeEach(async ({ context }) => { guards.set(context, await guardMockApplicationRequests(context)) })
test.afterEach(async ({ page, context }, info) => {
  const guard = guards.get(context)
  await info.attach('application-egress-guard', { body: JSON.stringify({ status: guard ? 'OBSERVED' : 'NOT_RUN', blocked: guard?.blocked, serviceWorkers: context.serviceWorkers().length }), contentType: 'application/json' })
  if (guard) { guard.assertNoUnexpectedRequests(); expect(context.serviceWorkers()).toEqual([]) }
  await info.attach('source-bound-synthetic-browser-observations', { body: JSON.stringify({ source, syntheticHttp: true, projection: 'synthetic-full-snapshot-not-exact-delta-v1', realPostgres: false, fullAppMounted: false, observation: await observe(page).catch(() => null) }, null, 2), contentType: 'application/json' })
})

test('native connected stop, receipt-only reload, original Undo, close and history', async ({ page }) => {
  await fresh(page); await open(page)
  await page.getByRole('button', { name: '不再跟进', exact: true }).press('Enter')
  await expect(page.getByRole('button', { name: '撤销不再跟进', exact: true })).toBeVisible()
  const first = await observe(page)
  expect(first.nativeIndexedDB).toBe('[object IDBFactory]'); expect(first.nativeLocks).toBe('[object LockManager]')
  expect(first.serverRevision).toBe(1); expect(first.localParticipation).toBe('abandoned'); expect(first.localActionStates).toEqual(['skipped', 'skipped']); expect(first.allWrites).toHaveLength(1)
  const id = first.locator.commandId
  await page.reload(); await expect(page.getByRole('button', { name: '撤销不再跟进', exact: true })).toBeVisible()
  expect((await observe(page)).allWrites).toHaveLength(1)
  await page.getByRole('button', { name: '撤销不再跟进', exact: true }).press('Space')
  await expect.poll(async () => (await observe(page)).serverRevision).toBe(2)
  await expect.poll(async () => (await observe(page)).localActionStates).toEqual(['todo', 'todo'])
  const undone = await observe(page); expect(undone.allWrites).toHaveLength(2); expect(undone.allWrites[1].targetCommandId).toBe(id); expect(undone.pending).toEqual([]); expect(undone.errors).toEqual([])
  await close(page); await page.goBack(); await expect(page.locator('.opportunity-detail-drawer')).toBeVisible(); await page.goForward(); await expect(page.locator('.opportunity-detail-drawer')).toHaveCount(0)
  expect((await observe(page)).allWrites).toHaveLength(2)
})

test('native Web Locks coordinate two tabs without a duplicate command', async ({ page, context }, info) => {
  await fresh(page); await page.getByRole('button', { name: 'Hold next command before synthetic commit', exact: true }).click(); await open(page)
  const second = await context.newPage()
  try {
  await second.goto(URL); await open(second)
  await page.getByRole('button', { name: '不再跟进', exact: true }).click()
  await expect.poll(async () => (await observe(page)).held).toBe(true)
  // The real storage listener has already observed the first tab's locator.
  // Its current UI is the original-operation check, not a stale Stop button.
  const checkOriginal = second.getByRole('button', { name: '核对原操作', exact: true })
  await expect(checkOriginal).toBeVisible(); await checkOriginal.click()
  await expect(checkOriginal).toBeDisabled()
  await expect.poll(async () => (await observe(page)).nativeLockHeld).toBe(1)
  await expect.poll(async () => (await observe(page)).nativeLockPending).toBe(1)
  expect((await observe(page)).allWrites).toHaveLength(1)
  await page.getByRole('button', { name: 'Release held request', exact: true }).click()
  await expect(page.getByRole('button', { name: '撤销不再跟进', exact: true })).toBeVisible()
  await expect(second.getByRole('button', { name: '撤销不再跟进', exact: true })).toBeVisible()
  const first = await observe(page), peer = await observe(second)
  expect(first.serverRevision).toBe(1); expect(first.allWrites).toHaveLength(1); expect(peer.locator.commandId).toBe(first.locator.commandId)
  expect(first.errors).toEqual([]); expect(peer.errors).toEqual([])
  await expect.poll(async () => (await observe(page)).nativeLockHeld).toBe(0)
  await expect.poll(async () => (await observe(page)).nativeLockPending).toBe(0)
  // A receipt lookup can legitimately finish after the confirmed UI paints.
  // Require convergence, then a real one-second quiet window; never suppress
  // storage events or turn feedback traffic into a passing diagnostic.
  let previous = '', stable = 0
  const readCounts = async () => { const a = await observe(page), b = await observe(second); return { counts: [a.receiptReads, b.receiptReads], inflight: a.receiptInflight + b.receiptInflight } }
  await expect.poll(async () => { const now = await readCounts(), value = JSON.stringify(now.counts); stable = now.inflight === 0 && value === previous ? stable + 1 : 0; previous = value; return stable }, { timeout: 5_000, intervals: [150, 150, 150] }).toBeGreaterThanOrEqual(3)
  const quietBefore = await readCounts(); await page.waitForTimeout(1000); const quietAfter = await readCounts()
  expect(quietAfter).toEqual(quietBefore); expect(quietAfter.inflight).toBe(0)
  } finally {
    await info.attach('second-tab-final-observations', { body: JSON.stringify({ observation: await observe(second).catch(() => null) }), contentType: 'application/json' })
    await second.close()
  }
})

test('blocked/read-only and shared governance never directly dispatch', async ({ page }) => {
  await fresh(page); await page.getByRole('button', { name: 'Toggle write blocked (false)', exact: true }).click(); await open(page)
  await expect(page.getByRole('button', { name: '不再跟进', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Toggle read only (false)', exact: true }).click(); await expect(page.locator('.job-detail-stop')).toHaveCount(0)
  expect((await observe(page)).allWrites).toEqual([])
  await fresh(page, 'Reset shared governance'); await open(page)
  await page.getByRole('button', { name: '不再跟进', exact: true }).click()
  await expect(page.getByText('Tell callback reached; no command submitted by the synthetic parent.', { exact: true })).toBeVisible()
  expect((await observe(page)).allWrites).toEqual([]); expect((await observe(page)).serverRevision).toBe(0)
})

test('local-only actual semantic change and in-mount Undo do not invoke backend', async ({ page }) => {
  await fresh(page, 'Reset local-only'); await open(page)
  await page.getByRole('button', { name: '不再跟进', exact: true }).click()
  await expect(page.getByRole('button', { name: '撤销不再跟进', exact: true })).toBeVisible()
  await expect.poll(async () => (await observe(page)).localParticipation).toBe('abandoned')
  await page.getByRole('button', { name: '撤销不再跟进', exact: true }).click()
  await expect.poll(async () => (await observe(page)).localActionStates).toEqual(['todo', 'todo'])
  const result = await observe(page); expect(result.allWrites).toEqual([]); expect(result.serverRevision).toBe(0); expect(result.errors).toEqual([])
})

test('A to B to A invalidates a held old component completion', async ({ page }) => {
  await fresh(page); await page.getByRole('button', { name: 'Hold next command before synthetic commit', exact: true }).click(); await open(page)
  await page.getByRole('button', { name: '不再跟进', exact: true }).click(); await expect.poll(async () => (await observe(page)).held).toBe(true)
  await page.getByRole('button', { name: 'Use account B', exact: true }).click(); await expect.poll(async () => (await observe(page)).account).toBe('B')
  await page.getByRole('button', { name: 'Use account A', exact: true }).click(); await expect.poll(async () => (await observe(page)).account).toBe('A')
  await page.getByRole('button', { name: 'Release held request', exact: true }).click()
  await expect.poll(async () => (await observe(page)).serverRevision).toBe(1)
  await expect.poll(async () => (await observe(page)).held).toBe(false)
  // No app scheduler is mounted: an old callback cannot apply its result across
  // the generation change. Original locator/pending identity remains available.
  const result = await observe(page); expect(result.localActionStates).toEqual(['todo', 'todo']); expect(result.allWrites).toHaveLength(1)
  expect(result.locator.commandId).toBe(result.allWrites[0].commandId)
  await expect(page.getByRole('button', { name: '撤销不再跟进', exact: true })).not.toBeVisible()
  expect(result.errors).toEqual([])
})
