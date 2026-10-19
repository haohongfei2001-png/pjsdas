import { test } from './support/voiceoverMockTest.js'
import { expect, type Locator } from '@playwright/test'
import { prepareJourney } from './support/cgr02Journey.js'

test('real VoiceOver can find Today, Tell TodayAction and the authoritative saved result', async ({ page, voiceOver }) => {
  const synchronizeFocusedSpeech = async (target: Locator, name: string) => {
    const compact = (value: string) => value.replace(/\s+/g, '')
    await expect(target).toBeFocused()
    // DOM focus can settle before the macOS accessibility cursor. Re-align
    // that cursor until it speaks this control; do not navigate away or repair
    // application focus with target.focus(), which could conceal a regression.
    await expect.poll(async () => {
      const focusedBefore = await target.evaluate(element => document.activeElement === element)
      if (!focusedBefore) return { focusedBefore }
      await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
      return {
        focusedBefore,
        focusedAfter: await target.evaluate(element => document.activeElement === element),
        spoken: compact(await voiceOver.lastSpokenPhrase()),
        item: compact(await voiceOver.itemText()),
      }
    }, { message: `VoiceOver must speak the focused control: ${name}`, timeout: 8_000, intervals: [100, 250, 500] }).toMatchObject({
      focusedBefore: true,
      focusedAfter: true,
      spoken: expect.stringContaining(compact(name)),
      item: expect.stringContaining(compact(name)),
    })
  }

  await prepareJourney(page)
  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()

  await page.bringToFront()
  await page.locator('.tsui-brand').focus()
  await synchronizeFocusedSpeech(page.locator('.tsui-brand'), 'TodayAction，今天')
  const headingPhrases: string[] = []
  let foundTodayTask = false
  for (let i = 0; i < 24; i += 1) {
    await voiceOver.nextHeading()
    const spoken = await voiceOver.lastSpokenPhrase()
    headingPhrases.push(spoken)
    if (spoken.includes('A第一任务')) {
      foundTodayTask = true
      break
    }
  }
  expect(foundTodayTask, headingPhrases.join(' | ')).toBe(true)

  await page.locator('.tsui-topbar').getByRole('button', { name: /告诉 TodayAction|Tell TodayAction/ }).click()
  const dialog = page.getByRole('dialog', { name: '告诉 TodayAction' })
  await expect(dialog).toHaveAttribute('aria-modal', 'false')
  const input = dialog.getByRole('textbox', { name: '要告诉 TodayAction 的内容' })
  await synchronizeFocusedSpeech(input, '要告诉 TodayAction 的内容')

  await input.fill('事项：填写报销单')
  await expect(dialog.getByText(/新增行动 · 填写报销单/)).toBeVisible()
  await dialog.getByRole('button', { name: '确认并保存' }).click()
  await expect(dialog.getByRole('status')).toContainText('已记录：填写报销单')
  // The nonmodal composer restores textarea focus when saving removes submit.
  // Accept the actual live announcement, or traverse from that verified focus.
  const receiptPhrases: string[] = [await voiceOver.lastSpokenPhrase()]
  const isReceipt = (spoken: string) => spoken.includes('已记录') && spoken.includes('填写报销单')
  let foundReceipt = receiptPhrases.some(isReceipt)
  await expect(input).toBeFocused()
  if (!foundReceipt) await synchronizeFocusedSpeech(input, '要告诉 TodayAction 的内容')
  for (let i = 0; i < 32 && !foundReceipt; i += 1) {
    await voiceOver.next()
    const spoken = await voiceOver.lastSpokenPhrase()
    receiptPhrases.push(spoken)
    foundReceipt = isReceipt(spoken)
  }
  expect(foundReceipt, receiptPhrases.join(' | ')).toBe(true)
})


test('real VoiceOver identifies Opportunities and Settings primary-route semantics', async ({ page, voiceOver }) => {
  await prepareJourney(page)

  await page.goto('/pjsdas/opportunities')
  await expect(page.getByRole('heading', { name: /岗位库|Job library/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /合成机会科技|AI产品经理/ })).toBeVisible()

  await page.bringToFront()
  await page.locator('.tsui-brand').focus()
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
  const opportunityPhrases: string[] = []
  let foundOpportunityContext = false
  for (let i = 0; i < 32 && !foundOpportunityContext; i += 1) {
    await voiceOver.next()
    const spoken = await voiceOver.lastSpokenPhrase()
    const item = await voiceOver.itemText()
    opportunityPhrases.push(`${spoken} / ${item}`)
    foundOpportunityContext = /合成机会科技|AI产品经理|哪些在推进/.test(`${spoken} ${item}`)
  }
  expect(foundOpportunityContext, opportunityPhrases.join(' | ')).toBe(true)

  const opportunityButton = page.getByRole('button', { name: /合成机会科技|AI产品经理/ })
  await opportunityButton.click()
  const detail = page.locator('.job-detail-page')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('合成机会科技')
  await page.bringToFront()
  await page.locator('.tsui-brand').focus()
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
  const detailPhrases: string[] = []
  let foundDetailSemantics = false
  for (let i = 0; i < 36 && !foundDetailSemantics; i += 1) {
    await voiceOver.next()
    const spoken = await voiceOver.lastSpokenPhrase()
    const item = await voiceOver.itemText()
    detailPhrases.push(`${spoken} / ${item}`)
    foundDetailSemantics = /结论|继续推进当前流程|阶段|面试|流程结果|进展与行动/.test(`${spoken} ${item}`)
  }
  expect(foundDetailSemantics, detailPhrases.join(' | ')).toBe(true)

  await page.goto('/pjsdas/settings')
  const settingsHeading = page.getByRole('heading', { name: /^(设置|Settings)$/i })
  await expect(settingsHeading).toBeVisible()
  await page.bringToFront()
  await page.locator('.tsui-brand').focus()
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
  const settingsPhrases: string[] = []
  let foundSettings = false
  for (let i = 0; i < 32 && !foundSettings; i += 1) {
    await voiceOver.nextHeading()
    const spoken = await voiceOver.lastSpokenPhrase()
    const item = await voiceOver.itemText()
    settingsPhrases.push(`${spoken} / ${item}`)
    foundSettings = /设置|Settings/i.test(`${spoken} ${item}`)
  }
  expect(foundSettings, settingsPhrases.join(' | ')).toBe(true)

  await expect(page.getByRole('button', { name: /立即同步|Sync now/ })).toHaveCount(0)
  await page.getByLabel(/管理账号与同步|Manage account and sync/).click()
  await expect(page.getByRole('button', { name: /立即同步|Sync now/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /退出 TodayAction|Sign out/ })).toBeVisible()
})


test('real VoiceOver finds a dated schedule node and its occurrence detail', async ({ page, voiceOver }) => {
  await prepareJourney(page)
  await page.goto('/pjsdas/schedule')
  await expect(page.getByRole('heading', { name: /^(日程|Schedule)$/ })).toBeVisible()
  const node = page.locator('.tsui-schedule-row').filter({ hasText: '合成机会科技' })
  await expect(node).toHaveCount(1)
  // Use the focused web control directly. The OS-wide Item Chooser can keep
  // a stale document from a previous test window and hang before web entry.
  await page.bringToFront()
  await node.focus()
  await expect(node).toBeFocused()
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
  const nodePhrases: string[] = []
  for (let i = 0; i < 4; i += 1) {
    nodePhrases.push((await voiceOver.lastSpokenPhrase()) + ' / ' + (await voiceOver.itemText()))
    if (nodePhrases.join(' ').includes('合成机会科技') && nodePhrases.join(' ').includes('面试')) break
    await voiceOver.next()
  }
  expect(nodePhrases.join(' ')).toContain('合成机会科技')
  expect(nodePhrases.join(' ')).toContain('面试')

  await node.click()
  const detail = page.locator('.tsui-schedule-detail')
  await expect(detail).toContainText('合成机会科技')
  await expect(detail).toContainText('2026-10-20')
  await expect(detail).toBeFocused()
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
  const detailPhrases: string[] = []
  let foundDetail = false
  for (let i = 0; i < 24 && !foundDetail; i += 1) {
    await voiceOver.nextHeading()
    const phrase = (await voiceOver.lastSpokenPhrase()) + ' / ' + (await voiceOver.itemText())
    detailPhrases.push(phrase)
    foundDetail = phrase.includes('面试')
  }
  expect(foundDetail, detailPhrases.join(' | ')).toBe(true)
})
