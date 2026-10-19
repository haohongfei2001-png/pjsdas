import { test } from './support/voiceoverMockTest.js'
import { expect } from '@playwright/test'
import { prepareJourney, waitForJourneyReady } from './support/cgr02Journey.js'

test('real VoiceOver can find Today, Tell TodayAction and the authoritative saved result', async ({ page, voiceOver }, testInfo) => {
  type Observation = { item: string; spoken: string[] }
  const observations: Array<Observation & { action: string }> = []
  const compact = (value: string) => value.replace(/\s+/g, '')
  const capture = async (action: string, perform: () => Promise<unknown>): Promise<Observation> => {
    const start = (await voiceOver.spokenPhraseLog()).length
    await perform()
    const observation = { item: await voiceOver.itemText(), spoken: (await voiceOver.spokenPhraseLog()).slice(start) }
    observations.push({ action, ...observation })
    return observation
  }
  const speaks = (observation: Observation, name: string) => observation.spoken.some(phrase => compact(phrase).includes(compact(name)))
  const namedItem = (item: string, name: string, role: 'button' | 'textbox') => {
    // Native itemText includes role metadata, e.g. "TodayAction，今天 button, group".
    // Strip only the expected role suffix, then compare the complete name. In
    // particular, the opener must never match the dialog or its named textarea.
    const suffix = role === 'button' ? /(?:,\s*)?\s*(?:(?:expanded|collapsed)\s+)?button\b[\s\S]*$/i
      : /(?:,\s*)?\s*(?:edit text|text entry area|text field|text area|textbox)\b[\s\S]*$/i
    return suffix.test(item) && compact(item.replace(suffix, '')) === compact(name)
  }
  const controls = page.locator('button, input:not([type="hidden"]), textarea, select, a[href], [role="button"], [role="textbox"], [tabindex]').filter({ visible: true })
  const findControl = async (name: string, role: 'button' | 'textbox', direction: 'next' | 'previous', current: Observation, spokenName = name) => {
    // One pass over this fixture's currently visible control inventory, not a
    // retry budget. Different controls may legitimately share the same name.
    const limit = await controls.count()
    for (let step = 0; step <= limit; step += 1) {
      if (namedItem(current.item, name, role)) {
        if (!speaks(current, spokenName)) {
          current = await capture(`describe ${name}`, () => voiceOver.perform(voiceOver.keyboardCommands.describeItem, { capture: true }))
        }
        expect(namedItem(current.item, name, role), JSON.stringify(current)).toBe(true)
        expect(speaks(current, spokenName), JSON.stringify(current)).toBe(true)
        if (role === 'button') expect(current.spoken.join(' ')).toMatch(/\bbutton\b/i)
        return current
      }
      if (step === limit) break
      current = await capture(`${direction} control for ${name}`, () => voiceOver.perform(
        direction === 'next' ? voiceOver.keyboardCommands.findNextControl : voiceOver.keyboardCommands.findPreviousControl,
        { capture: true },
      ))
    }
    throw new Error(`VoiceOver did not reach the exact ${role} "${name}" within one pass of ${limit} controls: ${JSON.stringify(observations)}`)
  }

  try {
    await prepareJourney(page)
    await page.goto('/pjsdas/today')
    await waitForJourneyReady(page)
    await expect(page.getByRole('heading', { name: 'A第一任务', exact: true })).toBeVisible()

    await page.bringToFront()
    await page.locator('.tsui-brand').focus()
    // Establish web entry once. Subsequent interaction stays on the native VO
    // cursor; CDP DOM focus alone does not establish macOS keyboard/AX focus.
    let current = await capture('enter at brand', () => voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus, { capture: true }))
    expect(namedItem(current.item, 'TodayAction，今天', 'button'), JSON.stringify(current)).toBe(true)
    expect(speaks(current, 'TodayAction，今天'), JSON.stringify(current)).toBe(true)
    const headingPhrases: string[] = []
    const headingLimit = Math.min(24, await page.getByRole('heading').count())
    let foundTodayTask = false
    for (let i = 0; i < headingLimit; i += 1) {
      current = await capture('next heading', () => voiceOver.nextHeading({ capture: true }))
      headingPhrases.push(...current.spoken)
      if (speaks(current, 'A第一任务')) {
        foundTodayTask = true
        break
      }
    }
    expect(foundTodayTask, headingPhrases.join(' | ')).toBe(true)

    const openerName = '＋ 告诉 TodayAction'
    await expect(page.locator('.tsui-topbar').getByRole('button', { name: openerName, exact: true })).toBeEnabled()
    // The decorative plus may be pronounced as a word; AX identity still uses
    // the exact complete name, while speech must name the full button function.
    current = await findControl(openerName, 'button', 'previous', current, '告诉 TodayAction')
    // Guidepup act performs the actual VoiceOver cursor's native AX action.
    // capture:true retains the complete announcement, not only its first chunk.
    current = await capture('activate capture opener', () => voiceOver.act({ capture: true }))
    const dialog = page.getByRole('dialog', { name: '告诉 TodayAction', exact: true })
    await expect(dialog).toHaveAttribute('aria-modal', 'false')
    const inputName = '要告诉 TodayAction 的内容'
    const input = dialog.getByRole('textbox', { name: inputName, exact: true })
    await expect(input).toBeFocused()
    // Native activation need not move the VO cursor into a nonmodal dialog.
    // Verify actual reachability and the full spoken input name independently.
    current = await capture('describe current item after opening', () => voiceOver.perform(voiceOver.keyboardCommands.describeItem, { capture: true }))
    current = await findControl(inputName, 'textbox', 'next', current)

    await input.fill('事项：填写报销单')
    await expect(dialog.getByText(/新增行动 · 填写报销单/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: '确认并保存', exact: true })).toBeEnabled()
    current = await findControl('确认并保存', 'button', 'next', current)
    const receiptLogStart = (await voiceOver.spokenPhraseLog()).length
    current = await capture('activate authoritative save', () => voiceOver.act({ capture: true }))
    await expect(dialog.getByRole('status')).toContainText('已记录：填写报销单')
    await expect(input).toBeFocused()
    let receiptPhrases = (await voiceOver.spokenPhraseLog()).slice(receiptLogStart)
    const isReceipt = (spoken: string) => spoken.includes('已记录') && spoken.includes('填写报销单')
    let foundReceipt = receiptPhrases.some(isReceipt)
    if (!foundReceipt) {
      // Re-enter through real native control navigation, never a CDP-focus repair.
      current = await capture('describe current item after saving', () => voiceOver.perform(voiceOver.keyboardCommands.describeItem, { capture: true }))
      current = await findControl(inputName, 'textbox', 'next', current)
      receiptPhrases = (await voiceOver.spokenPhraseLog()).slice(receiptLogStart)
      foundReceipt = receiptPhrases.some(isReceipt)
      // The receipt follows the textarea/tools in this settled composer. Bound
      // reading to its visible DOM elements, rather than looping the whole page.
      const receiptLimit = Math.min(32, await dialog.locator('*:visible').count())
      for (let i = 0; i < receiptLimit && !foundReceipt; i += 1) {
        current = await capture('read saved receipt', () => voiceOver.next({ capture: true }))
        receiptPhrases = (await voiceOver.spokenPhraseLog()).slice(receiptLogStart)
        foundReceipt = receiptPhrases.some(isReceipt)
      }
    }
    expect(foundReceipt, receiptPhrases.join(' | ')).toBe(true)
  } catch (error) {
    // Read-only official VO diagnostics distinguish native keyboard focus from
    // the emulated DOM focus. Preserve the failure before diagnostic speech.
    const diagnostics: Record<string, unknown> = { failure: String(error), observations: [...observations] }
    try {
      diagnostics.domFocus = await page.evaluate(() => ({
        documentHasFocus: document.hasFocus(),
        tag: document.activeElement?.tagName,
        id: document.activeElement?.id,
        name: document.activeElement?.getAttribute('aria-label'),
      }))
      diagnostics.spokenPhraseLog = [...await voiceOver.spokenPhraseLog()]
      diagnostics.itemTextLog = [...await voiceOver.itemTextLog()]
      diagnostics.keyboardFocus = await capture('diagnose keyboard focus', () => voiceOver.perform(voiceOver.keyboardCommands.describeItemWithKeyboardFocus, { capture: true }))
      diagnostics.window = await capture('diagnose window', () => voiceOver.perform(voiceOver.keyboardCommands.hearWindowSummary, { capture: true }))
    } catch (diagnosticError) {
      diagnostics.diagnosticError = String(diagnosticError)
    }
    await testInfo.attach('voiceover-native-focus-diagnostics', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' })
    throw error
  }
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
