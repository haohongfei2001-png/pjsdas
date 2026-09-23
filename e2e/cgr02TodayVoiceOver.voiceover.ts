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
