import { voiceOverTest as test } from '@guidepup/playwright'
import { expect, type Page, type Route } from '@playwright/test'
import { upgradeSnapshotToLatest } from '../src/snapshot.js'

const BACKEND = 'https://pjsdas-remote-alpha.vercel.app'
const AUTH_KEY = 'sb-yyrzwpoxlxpafdlbkdtg-auth-token'

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

async function prepareJourney(page: Page) {
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
      opportunities: [], processes: [], processEvents: [], prep: [], applicationGroups: [],
      semanticReceipts: [], timeline: [],
      actions: [{
        id: 'voiceover-action', kind: 'manual' as const, title: 'A第一任务',
        estimatedMinutes: 20, leverage: 80, delayCost: 80, status: 'todo' as const,
        createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
      }],
    },
  })
  let revision = 1
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
      const title = body.command.value.candidates?.find((item: any) => item.kind === 'manual_action')?.title ?? '整理面试材料'
      snapshot.data.actions.push({
        id: 'captured-action', kind: 'manual' as const, title, estimatedMinutes: 20,
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
}

test('real VoiceOver can find Today, Tell PJSDAS and the authoritative saved result', async ({ page, voiceOver }) => {
  await prepareJourney(page)
  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()

  await voiceOver.navigateToWebContent()
  let foundTodayTask = false
  for (let i = 0; i < 24; i += 1) {
    await voiceOver.nextHeading()
    if ((await voiceOver.lastSpokenPhrase()).includes('A第一任务')) {
      foundTodayTask = true
      break
    }
  }
  expect(foundTodayTask).toBe(true)

  await page.locator('.cgr-global-capture').click()
  const dialog = page.getByRole('dialog', { name: '告诉 PJSDAS' })
  const input = dialog.getByRole('textbox', { name: '要告诉 PJSDAS 的内容' })
  await expect(input).toBeFocused()
  const inputPhrases: string[] = []
  let foundInput = false
  for (let i = 0; i < 12 && !foundInput; i += 1) {
    // The browser moves focus to the textarea, while VoiceOver may retain its
    // prior cursor at the later Save control. Search backward through controls.
    await voiceOver.perform(voiceOver.keyboardCommands.findPreviousControl)
    const spoken = await voiceOver.lastSpokenPhrase()
    const item = await voiceOver.itemText()
    inputPhrases.push(`${spoken} / ${item}`)
    foundInput = /PJSDAS/.test(`${spoken} ${item}`) && /内容|告诉/.test(`${spoken} ${item}`)
  }
  expect(foundInput, inputPhrases.join(' | ')).toBe(true)

  await input.fill('事项：整理面试材料')
  await expect(dialog.getByText(/新增行动 · 整理面试材料/)).toBeVisible()
  await dialog.getByRole('button', { name: '确认并保存' }).click()
  await expect(dialog.getByRole('status')).toContainText('已记录：整理面试材料')
  const receiptPhrases: string[] = []
  let foundReceipt = (await voiceOver.lastSpokenPhrase()).includes('已记录')
  for (let i = 0; i < 32 && !foundReceipt; i += 1) {
    await voiceOver.next()
    const spoken = await voiceOver.lastSpokenPhrase()
    receiptPhrases.push(spoken)
    foundReceipt = spoken.includes('已记录') && spoken.includes('整理面试材料')
  }
  expect(foundReceipt, receiptPhrases.join(' | ')).toBe(true)
})
