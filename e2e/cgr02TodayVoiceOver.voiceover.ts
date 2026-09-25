import { voiceOverTest as test } from '@guidepup/playwright'
import { expect } from '@playwright/test'
import { prepareJourney } from './support/cgr02Journey.js'

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

  await page.locator('.tsui-topbar').getByRole('button', { name: /告诉 PJSDAS|Tell PJSDAS/ }).click()
  const dialog = page.getByRole('dialog', { name: '告诉 PJSDAS' })
  const input = dialog.getByRole('textbox', { name: '要告诉 PJSDAS 的内容' })
  await expect(input).toBeFocused()
  const inputPhrases: string[] = []
  // The dialog focuses the textarea. Align the VoiceOver cursor with that
  // keyboard focus before checking its actual spoken accessible name.
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
  let foundInput = false
  for (let i = 0; i < 4 && !foundInput; i += 1) {
    if (i) await voiceOver.perform(voiceOver.keyboardCommands.findNextControl)
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


test('real VoiceOver identifies Opportunities and Settings primary-route semantics', async ({ page, voiceOver }) => {
  await prepareJourney(page)

  await page.goto('/pjsdas/opportunities')
  await expect(page.getByRole('heading', { name: /岗位库|Job library/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /合成机会科技|AI产品经理/ })).toBeVisible()

  await voiceOver.navigateToWebContent()
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
  const detailPhrases: string[] = []
  let foundDetailSemantics = false
  for (let i = 0; i < 36 && !foundDetailSemantics; i += 1) {
    await voiceOver.next()
    const spoken = await voiceOver.lastSpokenPhrase()
    const item = await voiceOver.itemText()
    detailPhrases.push(`${spoken} / ${item}`)
    foundDetailSemantics = /结论|继续推进当前流程|阶段|面试|流程结果|准备与相关待办/.test(`${spoken} ${item}`)
  }
  expect(foundDetailSemantics, detailPhrases.join(' | ')).toBe(true)

  await page.goto('/pjsdas/settings')
  const settingsHeading = page.getByRole('heading', { name: /^(设置|Settings)$/i })
  await expect(settingsHeading).toBeVisible()
  await voiceOver.navigateToWebContent()
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

  await expect(page.getByRole('button', { name: /立即同步|Sync now/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /退出 PJSDAS|Sign out/ })).toBeVisible()
})
